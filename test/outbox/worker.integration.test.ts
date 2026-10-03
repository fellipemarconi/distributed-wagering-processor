import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:net';
import { Logger, type INestApplication } from '@nestjs/common';
import { boot, openWallet } from '../application/helpers';
import { SQS_DOWN, drain, enqueue, pendingRows, quiesce, rows, waitFor, wrapPublisher } from './helpers';

// `admin` não publica: serve para gravar e consultar. Os publishers ligados nascem em cada teste.
const admin = await boot();
const running: INestApplication[] = [];
const start = async (...args: Parameters<typeof boot>) => {
  const app = await boot({ outboxPublisherEnabled: true, outboxPollIntervalMs: 50, ...args[0] }, args[1]);
  running.push(app);
  return app;
};

beforeEach(() => quiesce(admin));
afterEach(() => Promise.all(running.splice(0).map((app) => app.close())));
afterAll(() => admin.close());

const allPublished = (ids: string[]) => async () => (await rows(admin, ids)).every((row) => row.published_at !== null);

test('instância com publisher ligado publica sozinha um evento gravado', async () => {
  await start();

  await openWallet(admin);
  const ids = (await pendingRows(admin)).map((row) => row.id);
  expect(ids).toHaveLength(2);

  await waitFor(allPublished(ids));
  expect((await drain()).map((m) => m.deduplicationId).sort()).toEqual([...ids].sort());
});

test('instância com publisher desligado grava na outbox e deixa pendente', async () => {
  await openWallet(admin);
  await Bun.sleep(300);

  expect(await pendingRows(admin)).toHaveLength(2);
  expect(await drain()).toEqual([]);
});

test('shutdown com lote em andamento termina o lote e não começa outro', async () => {
  const BATCH = 10;
  const ids: string[] = [];
  for (let i = 0; i < BATCH + 5; i++) ids.push((await enqueue(admin, { occurredAt: new Date(Date.now() - 60_000 + i) })).id);

  const firstSend = Promise.withResolvers<void>();
  let sends = 0;
  const app = await start(
    { outboxBatchSize: BATCH },
    wrapPublisher(async () => {
      sends += 1;
      firstSend.resolve();
      await Bun.sleep(60); // lote lento: o shutdown chega com ele pela metade
    }),
  );

  await firstSend.promise;
  expect(sends).toBeLessThan(BATCH);
  running.splice(running.indexOf(app), 1);
  await app.close();

  // close() só resolveu depois do lote inteiro enviado e registrado
  expect(sends).toBe(BATCH);
  const state = await rows(admin, ids);
  expect(state.map((row) => row.published_at !== null)).toEqual([...Array(BATCH).fill(true), ...Array(5).fill(false)]);
  expect((await drain()).map((m) => m.deduplicationId)).toEqual(ids.slice(0, BATCH));
});

test('shutdown durante a espera de polling não aguarda o intervalo', async () => {
  const app = await start({ outboxPollIntervalMs: 60_000 });
  await Bun.sleep(300); // primeiro lote (vazio) já rodou; o worker está dormindo

  const started = Date.now();
  running.splice(running.indexOf(app), 1);
  await app.close();

  expect(Date.now() - started).toBeLessThan(2000);
});

test('acima do limiar de tentativas cada falha gera warning, sem payload, e o evento não é abandonado', async () => {
  const warn = spyOn(Logger.prototype, 'warn');
  try {
    const stuck = await enqueue(admin, { attempts: 6 });
    const fresh = await enqueue(admin, { occurredAt: new Date(Date.now() + 1000) }); // mesma indisponibilidade, abaixo do limiar

    await start({ ...SQS_DOWN, outboxPollIntervalMs: 20 });
    await waitFor(async () => (await rows(admin, [stuck.id, fresh.id])).every((row) => row.attempts > 0 && row.next_attempt_at !== null));

    const [stuckRow, freshRow] = await rows(admin, [stuck.id, fresh.id]);
    expect(stuckRow).toMatchObject({ attempts: 7, published_at: null });
    expect(stuckRow!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(freshRow).toMatchObject({ attempts: 1, published_at: null });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ eventId: stuck.id, eventType: 'TestEvent', aggregateId: stuck.aggregateId, attempts: 7 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('payload-nao-vai-para-o-log');
  } finally {
    warn.mockRestore();
  }
});

test('crash depois do commit e antes de publicar: outra instância publica', async () => {
  const port = await freePort();
  // processo real, com o publisher desligado: grava e é morto sem nunca publicar
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), OUTBOX_PUBLISHER_ENABLED: 'false', LOG_LEVEL: 'log' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  let walletId: string;
  try {
    const base = `http://localhost:${port}`;
    await waitFor(() => fetch(`${base}/health/live`).then((r) => r.ok, () => false));

    const response = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(response.status).toBe(201); // commit confirmado
    walletId = ((await response.json()) as { id: string }).id;
  } finally {
    proc.kill('SIGKILL');
    await proc.exited;
  }

  const orphans = await pendingRows(admin);
  expect(orphans.map((row) => row.payload.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(orphans.some((row) => row.aggregate_id === walletId)).toBe(true);
  expect(await drain()).toEqual([]);

  await start();
  const ids = orphans.map((row) => row.id);
  await waitFor(allPublished(ids));

  expect((await drain()).map((m) => m.deduplicationId).sort()).toEqual([...ids].sort());
}, 30_000);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
