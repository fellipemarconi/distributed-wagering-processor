import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { EventPublisher, EventPublisherUnavailableError } from '../../src/application/ports';
import { boot, openWallet } from '../application/helpers';
import {
  SQS_DOWN,
  drain,
  enqueue,
  failFirstSave,
  pendingRows,
  quiesce,
  rows,
  runBatch,
  wrapPublisher,
} from './helpers';

// Postgres e LocalStack reais. Worker desligado: cada teste dispara os lotes na mão.
const app = await boot();
const extras: INestApplication[] = [];
const also = async (booting: Promise<INestApplication>) => {
  const other = await booting;
  extras.push(other);
  return other;
};

beforeEach(async () => {
  await Promise.all(extras.splice(0).map((other) => other.close()));
  await quiesce(app);
});
afterAll(async () => {
  await Promise.all(extras.map((other) => other.close()));
  await app.close();
});

const at = (ms: number) => new Date(Date.now() - 60_000 + ms);
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe('publicação dos eventos pendentes', () => {
  test('eventos gravados por um use case chegam à fila com o envelope gravado e ficam publicados', async () => {
    const wallet = await openWallet(app);
    const pending = await pendingRows(app);
    expect(pending).toHaveLength(2);

    expect(await runBatch(app)).toEqual({ claimed: 2, published: 2, failures: [], interrupted: false });

    const received = (await drain()).sort((a, b) => a.deduplicationId.localeCompare(b.deduplicationId));
    expect(received).toEqual(
      pending.sort(byId).map((row) => ({ body: row.payload, groupId: row.aggregate_id, deduplicationId: row.id })),
    );
    expect(received.map((m) => m.body.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const m of received) {
      expect(m.body.eventId).toBe(m.deduplicationId);
      expect(m.body.aggregateId).toBe(m.groupId);
    }
    expect(received.find((m) => m.body.eventType === 'WalletBalanceChanged')!.groupId).toBe(wallet.id);

    const after = await rows(app, pending.map((row) => row.id));
    expect(after.every((row) => row.published_at !== null && row.attempts === 0)).toBe(true);

    // já publicada não é republicada
    expect(await runBatch(app)).toMatchObject({ claimed: 0, published: 0 });
    expect(await drain()).toEqual([]);
  });

  test('o adapter SQS publica com corpo = payload, grupo = agregado e dedup = eventId', async () => {
    const message = await enqueue(app);

    await app.get(EventPublisher).publish(message);

    expect(await drain()).toEqual([
      { body: JSON.parse(JSON.stringify(message.payload)), groupId: message.aggregateId, deduplicationId: message.id },
    ]);
  });

  test('mensagem aguardando backoff não é enviada', async () => {
    const waiting = await enqueue(app, { attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000) });

    expect(await runBatch(app)).toMatchObject({ claimed: 0, published: 0 });

    expect(await drain()).toEqual([]);
    expect((await rows(app, [waiting.id]))[0]).toMatchObject({ attempts: 1, published_at: null });
  });
});

describe('SQS indisponível interrompe o lote', () => {
  test('só uma mensagem tem attempts incrementado; ao voltar, todas são publicadas', async () => {
    const down = await also(boot(SQS_DOWN));
    const messages = [await enqueue(app, { occurredAt: at(0) }), await enqueue(app, { occurredAt: at(1) }), await enqueue(app, { occurredAt: at(2) }), await enqueue(app, { occurredAt: at(3) })];
    const ids = messages.map((m) => m.id);

    const before = Date.now();
    const result = await runBatch(down);

    expect(result).toMatchObject({ claimed: 4, published: 0, interrupted: true });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ eventId: ids[0]!, attempts: 1 });

    const [probe, ...untouched] = await rows(app, ids);
    expect(probe!.attempts).toBe(1);
    // backoff da 1ª tentativa: ~1s à frente
    const delay = probe!.next_attempt_at!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(1000 + (Date.now() - before) + 50);
    expect(untouched.map((row) => [row.attempts, row.next_attempt_at, row.published_at])).toEqual([
      [0, null, null],
      [0, null, null],
      [0, null, null],
    ]);

    // rodada imediata: a que falhou está em backoff e não é reenviada (a sonda passa a ser a seguinte)
    const second = await runBatch(down);
    expect(second).toMatchObject({ claimed: 3, published: 0, interrupted: true });
    expect(second.failures.map((f) => f.eventId)).toEqual([ids[1]!]);
    expect((await rows(app, ids)).map((row) => row.attempts)).toEqual([1, 1, 0, 0]);

    // SQS de volta e backoff vencido: tudo publicado, tentativas preservadas
    await Bun.sleep(1100);
    expect(await runBatch(app)).toMatchObject({ claimed: 4, published: 4, interrupted: false });
    const final = await rows(app, ids);
    expect(final.every((row) => row.published_at !== null)).toBe(true);
    expect(final.map((row) => row.attempts)).toEqual([1, 1, 0, 0]);
    expect((await drain()).map((m) => m.deduplicationId).sort()).toEqual([...ids].sort());
  });

  test('queda no meio do lote: o que já foi publicado é confirmado, o resto fica intocado', async () => {
    let calls = 0;
    const flaky = await also(
      boot({}, wrapPublisher(() => {
        if (++calls >= 3) throw new EventPublisherUnavailableError();
      })),
    );
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await enqueue(app, { occurredAt: at(i) })).id);

    const result = await runBatch(flaky);

    expect(result).toMatchObject({ claimed: 5, published: 2, interrupted: true });
    expect(calls).toBe(3);
    const state = await rows(app, ids);
    expect(state.map((row) => row.published_at !== null)).toEqual([true, true, false, false, false]);
    expect(state.map((row) => row.attempts)).toEqual([0, 0, 1, 0, 0]);
    expect(state.slice(3).map((row) => row.next_attempt_at)).toEqual([null, null]);
    expect((await drain()).map((m) => m.deduplicationId)).toEqual(ids.slice(0, 2));
  });

  test('SQS que aceita a conexão e não responde: um tempo limite para o lote, não um por mensagem', async () => {
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const hanging = await also(boot({ awsEndpointUrl: `http://127.0.0.1:${silent.port}`, outboxPublishTimeoutMs: 400 }));
      const ids = [(await enqueue(app, { occurredAt: at(0) })).id, (await enqueue(app, { occurredAt: at(1) })).id, (await enqueue(app, { occurredAt: at(2) })).id];

      const started = Date.now();
      const result = await runBatch(hanging);
      const elapsed = Date.now() - started;

      expect(result).toMatchObject({ claimed: 3, published: 0, interrupted: true });
      expect(result.failures).toHaveLength(1);
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(1000); // três tempos limite seriam ≥ 1200ms
      expect((await rows(app, ids)).map((row) => row.attempts)).toEqual([1, 0, 0]);
    } finally {
      silent.stop(true);
    }
  });
});

describe('ordem por agregado dentro do lote', () => {
  test('depois que um evento do agregado falha, os seguintes do mesmo agregado são pulados', async () => {
    const sent: string[] = [];
    let refused = '';
    const picky = await also(
      boot({}, wrapPublisher((message) => {
        sent.push(message.id);
        if (message.id === refused) throw new Error('mensagem recusada pelo SQS');
      })),
    );
    const a1 = await enqueue(app, { occurredAt: at(0) });
    const b1 = await enqueue(app, { occurredAt: at(1) });
    const a2 = await enqueue(app, { occurredAt: at(2), aggregateId: a1.aggregateId });
    refused = a1.id;

    const result = await runBatch(picky);

    // erro não transitório: não interrompe o lote, só o agregado
    expect(result).toMatchObject({ claimed: 3, published: 1, interrupted: false });
    expect(result.failures).toEqual([
      { eventId: a1.id, eventType: 'TestEvent', aggregateId: a1.aggregateId, attempts: 1, error: 'mensagem recusada pelo SQS' },
    ]);
    expect(sent).toEqual([a1.id, b1.id]); // A2 nem foi enviado

    const [rowA1, rowB1, rowA2] = await rows(app, [a1.id, b1.id, a2.id]);
    expect(rowA1).toMatchObject({ attempts: 1, published_at: null });
    expect(rowB1!.published_at).not.toBeNull();
    expect(rowA2).toMatchObject({ attempts: 0, next_attempt_at: null, published_at: null });

    // Limitação documentada (design D7): no lote seguinte A1 está em backoff e A2 é publicado antes dele.
    expect(await runBatch(picky)).toMatchObject({ claimed: 1, published: 1 });
    expect((await drain()).map((m) => m.deduplicationId)).toEqual([b1.id, a2.id]);
  });
});

describe('entrega at-least-once', () => {
  test('crash depois de publicar e antes de marcar: reenvio com o mesmo eventId e o mesmo corpo', async () => {
    const sent: Array<{ id: string; body: string }> = [];
    const crashing = await also(
      boot({}, (builder) =>
        failFirstSave(wrapPublisher((message) => void sent.push({ id: message.id, body: JSON.stringify(message.payload) }))(builder)),
      ),
    );
    const message = await enqueue(app);

    // o SQS aceitou, o registro não foi confirmado: a transação do lote é desfeita
    await expect(runBatch(crashing)).rejects.toThrow('processo caiu antes de marcar');
    expect((await rows(app, [message.id]))[0]).toMatchObject({ attempts: 0, next_attempt_at: null, published_at: null });

    expect(await runBatch(crashing)).toMatchObject({ claimed: 1, published: 1 });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]!);
    expect(sent[0]!.id).toBe(message.id);
    expect((await rows(app, [message.id]))[0]!.published_at).not.toBeNull();
    // dentro da janela de dedup do FIFO o SQS aceita o reenvio e entrega uma cópia só;
    // fora dela o consumidor deduplica pelo eventId, que é o mesmo
    expect((await drain()).map((m) => m.deduplicationId)).toEqual([message.id]);
  });
});

describe('publishers concorrentes', () => {
  test('dois publishers sobre a mesma outbox: nada perdido, nada enviado pelos dois', async () => {
    const TOTAL = 200;
    const sentBy: Record<string, string[]> = { a: [], b: [] };
    const publisher = (name: string) => also(boot({}, wrapPublisher((message) => void sentBy[name]!.push(message.id))));
    const [a, b] = [await publisher('a'), await publisher('b')];

    const ids = (await Promise.all(Array.from({ length: TOTAL }, (_, i) => enqueue(app, { occurredAt: at(i) })))).map((m) => m.id);

    const drainOutbox = async (instance: INestApplication) => {
      while ((await runBatch(instance)).claimed > 0);
    };
    await Promise.all([drainOutbox(a), drainOutbox(b)]);

    const all = [...sentBy.a!, ...sentBy.b!];
    expect(all).toHaveLength(TOTAL); // nenhum enviado duas vezes…
    expect(new Set(all)).toEqual(new Set(ids)); // …e nenhum perdido
    expect(sentBy.a!.length).toBeGreaterThan(0);
    expect(sentBy.b!.length).toBeGreaterThan(0);

    expect((await rows(app, ids)).every((row) => row.published_at !== null && row.attempts === 0)).toBe(true);
    expect(await pendingRows(app)).toEqual([]);
    expect(new Set((await drain()).map((m) => m.deduplicationId))).toEqual(new Set(ids));
  }, 60_000);
});
