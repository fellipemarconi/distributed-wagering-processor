import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import { AuthGuard } from '../../src/http/auth.guard';
import { createSqsClient } from '../../src/infra/sqs.provider';
import { boot, openWallet, payload, submitted, uuid } from '../application/helpers';
import { DB_DOWN, DLQ, MAIN, envelope, holdingLock, mainEmpty, quiesce as quiesceQueues, send } from '../consumer/helpers';
import { SQS_DOWN, enqueue, quiesce as quiesceOutbox, waitFor } from '../outbox/helpers';
import { quiescePending, referencing, txRow } from '../pending-reference/helpers';
import { metric, scrape, valueOf } from './helpers';

// Asserções sempre por delta (antes/depois): cada app tem o seu registry, mas o que importa é a variação.
const app = await boot();
const url = await app.getUrl();
const running: INestApplication[] = [];
const start = async (...args: Parameters<typeof boot>) => {
  const started = await boot(...args);
  running.push(started);
  return started;
};
afterEach(() => Promise.all(running.splice(0).map((a) => a.close())));
afterAll(() => app.close());

/** Tudo que não pode aparecer em /metrics: ids e valores usados nos testes. */
const forbidden = new Set<string>(['provider-a']);
const AMOUNT = '731.37';
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function wallet(target: INestApplication = app, amount = '5000.00') {
  const w = await openWallet(target, amount);
  forbidden.add(w.id).add(w.playerId);
  return w;
}

function request(w: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const body = payload(w, { money: brl(AMOUNT), ...overrides });
  forbidden.add(body.externalTransactionId);
  return body;
}

async function post(body: ReturnType<typeof request>, base = url) {
  const { idempotencyKey, ...rest } = body;
  const res = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(rest),
  });
  const json = (await res.json()) as Record<string, any>;
  if (json.transactionId) forbidden.add(json.transactionId);
  return { status: res.status, body: json };
}

/** Variação de uma série de `target` durante `action`. */
async function delta(target: INestApplication, name: string, labels: Record<string, string>, action: () => Promise<unknown>) {
  const before = await metric(target, name, labels);
  await action();
  return (await metric(target, name, labels)) - before;
}

const increased = (target: INestApplication, name: string, labels: Record<string, string>, from: number) => async () =>
  (await metric(target, name, labels)) > from;

const METRICS = {
  wagering_transactions_total: 'counter',
  wagering_duplicates_total: 'counter',
  wagering_retries_total: 'counter',
  wagering_dlq_messages_total: 'counter',
  wagering_dlq_depth: 'gauge',
  wagering_lock_conflicts_total: 'counter',
  wagering_outbox_oldest_pending_age_seconds: 'gauge',
  wagering_outbox_publish_lag_seconds: 'histogram',
  wagering_processing_duration_seconds: 'histogram',
  wagering_reconciliation_divergences_total: 'counter',
};

describe('GET /metrics', () => {
  test('200 em formato Prometheus, declarando todas as métricas desde o início', async () => {
    const fresh = await start(); // segundo app no mesmo processo: registries independentes
    const res = await fetch(`${await fresh.getUrl()}/metrics`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain;.*version=0\.0\.4/);
    for (const [name, type] of Object.entries(METRICS)) expect(text).toContain(`# TYPE ${name} ${type}`);
    expect(valueOf(text, 'wagering_transactions_total')).toBe(0); // nada do que o outro app contou
  });

  test('continua aberto com o AuthGuard negando tudo', async () => {
    const denied = await start({}, (b) => b.overrideGuard(AuthGuard).useValue({ canActivate: () => false }));
    const base = await denied.getUrl();

    expect((await fetch(`${base}/wallets/${uuid()}`)).status).toBe(403);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });
});

describe('canal http', () => {
  const tx = (kind: string, status: string) => ({ kind, status, channel: 'http' });
  const replays = { type: 'idempotent_replay', channel: 'http' };

  test('aposta aplicada conta transação e latência', async () => {
    const w = await wallet();
    const latency = await metric(app, 'wagering_processing_duration_seconds_count', { channel: 'http' });

    expect(await delta(app, 'wagering_transactions_total', tx('BET', 'PROCESSED'), () => post(request(w)))).toBe(1);
    expect(await metric(app, 'wagering_processing_duration_seconds_count', { channel: 'http' })).toBe(latency + 1);
  });

  test('aposta rejeitada conta com status REJECTED', async () => {
    const w = await wallet(app, '1.00');
    expect(await delta(app, 'wagering_transactions_total', tx('BET', 'REJECTED'), () => post(request(w)))).toBe(1);
  });

  test('replay conta duplicata e não conta transação', async () => {
    const w = await wallet();
    const req = request(w);
    await post(req);
    const transactions = await metric(app, 'wagering_transactions_total');

    expect(await delta(app, 'wagering_duplicates_total', replays, async () => expect((await post(req)).status).toBe(200))).toBe(1);
    expect(await metric(app, 'wagering_transactions_total')).toBe(transactions);
  });

  test('REFUND antes da BET conta PENDING_REFERENCE', async () => {
    const w = await wallet();
    const refund = request(w, { kind: 'REFUND', referenceExternalTransactionId: uuid() });
    expect(await delta(app, 'wagering_transactions_total', tx('REFUND', 'PENDING_REFERENCE'), () => post(refund))).toBe(1);
  });

  test('wallet com saldo inicial conta OPENING; sem saldo inicial não', async () => {
    const create = (amount: string) =>
      fetch(`${url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: uuid(), initialBalance: brl(amount) }),
      });
    expect(await delta(app, 'wagering_transactions_total', tx('OPENING', 'PROCESSED'), () => create(AMOUNT))).toBe(1);
    expect(await delta(app, 'wagering_transactions_total', tx('OPENING', 'PROCESSED'), () => create('0.00'))).toBe(0);
  });
});

describe('canal sqs', () => {
  beforeEach(quiesceQueues);
  const consumer = (overrides: Parameters<typeof boot>[0] = {}) =>
    start({ sqsConsumerEnabled: true, sqsConsumerWaitTimeSeconds: 1, ...overrides });

  function message(w: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    const m = envelope(request(w, overrides));
    forbidden.add(m.messageId);
    return m;
  }

  test('mensagem aplicada, mensagem reentregue (inbox) e latência', async () => {
    const c = await consumer();
    const w = await wallet();
    const m = message(w);

    await send(m);
    await waitFor(increased(c, 'wagering_transactions_total', { kind: 'BET', status: 'PROCESSED', channel: 'sqs' }, 0));
    await send(m); // mesma mensagem de novo
    await waitFor(increased(c, 'wagering_duplicates_total', { type: 'inbox_duplicate', channel: 'sqs' }, 0));

    const text = await scrape(c);
    expect(valueOf(text, 'wagering_transactions_total', { channel: 'sqs' })).toBe(1);
    expect(valueOf(text, 'wagering_duplicates_total', { channel: 'sqs' })).toBe(1);
    expect(valueOf(text, 'wagering_processing_duration_seconds_count', { channel: 'sqs' })).toBe(2);
  }, 20_000);

  test('mesma transação em mensagem nova conta replay idempotente', async () => {
    const c = await consumer();
    const w = await wallet();
    const first = message(w);
    const again = envelope(first.data);
    forbidden.add(again.messageId);

    await send(first);
    await send(again);
    await waitFor(increased(c, 'wagering_duplicates_total', { type: 'idempotent_replay', channel: 'sqs' }, 0));
  }, 20_000);

  test('DLQ por reason: payload inválido e wallet inexistente', async () => {
    const c = await consumer();
    const w = await wallet();

    await send(message(w, { money: brl('1.005') }));
    await send(message({ id: uuid(), playerId: uuid() }));
    await waitFor(async () => (await metric(c, 'wagering_dlq_messages_total')) === 2);

    const text = await scrape(c);
    expect(valueOf(text, 'wagering_dlq_messages_total', { reason: 'INVALID_PAYLOAD' })).toBe(1);
    expect(valueOf(text, 'wagering_dlq_messages_total', { reason: 'WALLET_NOT_FOUND' })).toBe(1);
    await waitFor(async () => (await metric(c, 'wagering_dlq_depth')) === 2); // enviadas pelo consumidor também estão lá
  }, 20_000);

  test('wallet travada além do limite: retry e lock_timeout contados uma vez (transação aninhada)', async () => {
    const c = await consumer({ dbLockTimeoutMs: 200 });
    const w = await wallet();

    await holdingLock(app, w.id, async () => {
      await send(message(w));
      await waitFor(increased(c, 'wagering_retries_total', { source: 'sqs_consumer' }, 0));
      const text = await scrape(c);
      expect(valueOf(text, 'wagering_retries_total', { source: 'sqs_consumer' })).toBe(1);
      expect(valueOf(text, 'wagering_lock_conflicts_total', { type: 'lock_timeout' })).toBe(1);
    });
    await waitFor(mainEmpty, 15_000); // liberada a wallet, a reentrega aplica
    expect(await metric(c, 'wagering_transactions_total', { status: 'PROCESSED', channel: 'sqs' })).toBe(1);
  }, 30_000);
});

describe('DLQ: contador do consumidor × profundidade no broker', () => {
  beforeEach(quiesceQueues);
  afterAll(quiesceQueues);

  test('mensagem movida pelo redrive do SQS aparece no gauge e não no contador', async () => {
    const sqs = createSqsClient(loadConfig());
    const w = await wallet();
    const m = envelope(request(w));
    forbidden.add(m.messageId);
    await waitFor(async () => (await metric(app, 'wagering_dlq_depth')) === 0); // purge concluído
    const sentByConsumer = await metric(app, 'wagering_dlq_messages_total');

    // Nenhum consumidor ligado: a mensagem é recebida e abandonada (visibilidade 0) até passar do
    // maxReceiveCount (8); no recebimento seguinte o SQS a move para a DLQ.
    await send(m);
    for (let receives = 0; receives < 12; receives++) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: MAIN, MaxNumberOfMessages: 1, VisibilityTimeout: 0, WaitTimeSeconds: 0 }),
      );
      if (Messages.length === 0) break;
    }

    await waitFor(async () => (await metric(app, 'wagering_dlq_depth')) === 1);
    expect(await metric(app, 'wagering_dlq_messages_total')).toBe(sentByConsumer);
    expect(DLQ).toContain('dlq');
  }, 30_000);

  test('SQS indisponível: /metrics responde 200 em pouco mais que o tempo limite, com o resto das métricas', async () => {
    const down = await start(SQS_DOWN);
    const started = Date.now();
    const res = await fetch(`${await down.getUrl()}/metrics`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(text).toMatch(/^wagering_dlq_depth Nan$/m);
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(valueOf(text, 'wagering_outbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(0);
  });
});

describe('worker de PENDING_REFERENCE', () => {
  beforeEach(() => quiescePending(app));

  test('pendente reagendada conta retry; concluída conta transação e latência no canal worker', async () => {
    const worker = await start({ pendingReferenceWorkerEnabled: true, pendingReferencePollIntervalMs: 50 });
    const w = await wallet();
    const bet = request(w);
    const refund = await submitted(app, referencing(w, bet.externalTransactionId, { money: brl(AMOUNT) }));
    forbidden.add(refund.id);

    await waitFor(increased(worker, 'wagering_retries_total', { source: 'pending_reference' }, 0));
    expect(await metric(worker, 'wagering_transactions_total', { channel: 'worker' })).toBe(0);

    await submitted(app, bet); // a referência chega e antecipa a pendente
    await waitFor(async () => (await txRow(app, refund.id)).status === 'PROCESSED');
    await waitFor(increased(worker, 'wagering_transactions_total', { kind: 'REFUND', status: 'PROCESSED', channel: 'worker' }, 0));
    expect(await metric(worker, 'wagering_processing_duration_seconds_count', { channel: 'worker' })).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe('outbox', () => {
  beforeEach(() => quiesceOutbox(app));
  afterAll(() => quiesceOutbox(app));
  const AGE = 'wagering_outbox_oldest_pending_age_seconds';

  test('idade da pendente mais antiga vem do banco: cresce sem publisher e volta a 0 depois de publicar', async () => {
    expect(await metric(app, AGE)).toBe(0);
    await enqueue(app, { occurredAt: new Date(Date.now() - 5000) });

    const first = await metric(app, AGE);
    await Bun.sleep(300);
    const second = await metric(app, AGE);
    expect(first).toBeGreaterThanOrEqual(5);
    expect(second).toBeGreaterThan(first);

    const publisher = await start({ outboxPublisherEnabled: true, outboxPollIntervalMs: 50 });
    await waitFor(increased(publisher, 'wagering_outbox_publish_lag_seconds_count', {}, 0));
    expect(await metric(publisher, 'wagering_outbox_publish_lag_seconds_sum')).toBeGreaterThanOrEqual(5);
    // a instância que não publicou enxerga o mesmo estado: o gauge não é memória de processo
    expect(await metric(app, AGE)).toBe(0);
  }, 20_000);

  test('publicação com SQS indisponível conta retry', async () => {
    const publisher = await start({ ...SQS_DOWN, outboxPublisherEnabled: true, outboxPollIntervalMs: 50 });
    await enqueue(app);
    await waitFor(increased(publisher, 'wagering_retries_total', { source: 'outbox' }, 0));
    expect(await metric(publisher, 'wagering_outbox_publish_lag_seconds_count')).toBe(0);
  }, 20_000);

  test('banco inacessível: /metrics responde 200 com o resto das métricas', async () => {
    const down = await start(DB_DOWN);
    const res = await fetch(`${await down.getUrl()}/metrics`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toMatch(/^wagering_outbox_oldest_pending_age_seconds Nan$/m);
    expect(text).toContain('# TYPE wagering_transactions_total counter');
  });
});

describe('conflitos de lock', () => {
  test('wallet travada além do limite via HTTP: lock_timeout sobe exatamente 1', async () => {
    const impatient = await start({ dbLockTimeoutMs: 200 });
    const base = await impatient.getUrl();
    const w = await wallet();

    const blocked = await holdingLock(app, w.id, () => post(request(w), base));

    expect(blocked.status).toBe(503);
    expect(await metric(impatient, 'wagering_lock_conflicts_total', { type: 'lock_timeout' })).toBe(1);
    expect(await metric(impatient, 'wagering_lock_conflicts_total')).toBe(1);
  });

  test('mesma chave em wallets diferentes, em paralelo: a unicidade decide e unique_violation é contado', async () => {
    const racing = await start();
    const base = await racing.getUrl();
    const [a, b] = [await wallet(), await wallet()];
    const conflicts = () => metric(racing, 'wagering_lock_conflicts_total', { type: 'unique_violation' });

    // o lock é por wallet, então as duas não se serializam; repete até a corrida acontecer
    for (let round = 0; round < 30 && (await conflicts()) === 0; round++) {
      const first = request(a);
      const second = { ...request(b), idempotencyKey: first.idempotencyKey };
      const replies = await Promise.all([post(first, base), post(second, base)]);
      expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    }
    expect(await conflicts()).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('wallet duplicada é conflito de negócio: não conta', async () => {
    const playerId = uuid();
    const create = () =>
      fetch(`${url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: brl('1.00') }),
      });
    await create();

    expect(await delta(app, 'wagering_lock_conflicts_total', {}, async () => expect((await create()).status).toBe(409))).toBe(0);
  });
});

test('nenhum id nem valor monetário usado nos testes aparece em /metrics', async () => {
  const text = await scrape(app);
  expect(valueOf(text, 'wagering_transactions_total')).toBeGreaterThan(0);
  expect(forbidden.size).toBeGreaterThan(20);
  for (const value of [...forbidden, AMOUNT]) expect(text).not.toContain(value);
  // toda label vem de um conjunto fechado
  const labels = new Set([...text.matchAll(/(\w+)="/g)].map((m) => m[1]));
  expect(labels.size).toBeGreaterThan(0);
  for (const label of labels) expect(['channel', 'kind', 'le', 'reason', 'source', 'status', 'type']).toContain(label);
  await app.get(MikroORM).em.getConnection().execute('select 1'); // app segue saudável
});
