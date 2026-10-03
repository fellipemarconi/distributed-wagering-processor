import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import { balanceOf, boot, expectLedgerInvariant, openWallet, payload, submitted } from '../application/helpers';
import { waitFor } from '../outbox/helpers';
import { patchTx, quiescePending, referencing, secondsAgo, txRow } from './helpers';

// `admin` não reavalia: serve para gravar e consultar. Os workers ligados nascem em cada teste.
const admin = await boot();
const running: INestApplication[] = [];
const start = async (overrides: Parameters<typeof boot>[0] = {}) => {
  const app = await boot({ pendingReferenceWorkerEnabled: true, pendingReferencePollIntervalMs: 50, ...overrides });
  running.push(app);
  return app;
};

beforeEach(() => quiescePending(admin));
afterEach(() => Promise.all(running.splice(0).map((app) => app.close())));
afterAll(() => admin.close());

const statusIs = (id: string, status: string) => async () => (await txRow(admin, id)).status === status;

test('instância com worker ligado resolve sozinha a pendente quando a referência chega', async () => {
  await start();
  const w = await openWallet(admin, '100.00');
  const betInput = payload(w);
  const refund = await submitted(admin, referencing(w, betInput.externalTransactionId));
  await Bun.sleep(200); // o worker já tentou sem a referência e a pendente entrou em backoff

  await submitted(admin, betInput);

  await waitFor(statusIs(refund.id, 'PROCESSED'), 3000);
  expect(await balanceOf(admin, w.id)).toBe('100.00');
  await expectLedgerInvariant(admin, w.id);
});

test('instância com worker ligado rejeita sozinha a pendente expirada, com log sem valores monetários', async () => {
  const log = spyOn(Logger.prototype, 'log');
  try {
    const w = await openWallet(admin, '123.45');
    const refund = await submitted(admin, referencing(w, 'nunca-chega', { money: { amount: '67.89', currency: 'BRL' } }));
    await patchTx(admin, refund.id, { created_at: secondsAgo(901) });

    await start();
    await waitFor(statusIs(refund.id, 'REJECTED'), 3000);

    expect((await txRow(admin, refund.id)).failure_code).toBe('REFERENCE_NOT_FOUND');
    const entry = log.mock.calls.map((call) => call[0]).find((m) => (m as { transactionId?: string }).transactionId === refund.id);
    expect(entry).toMatchObject({ outcome: 'rejected', failureCode: 'REFERENCE_NOT_FOUND', attempts: 0 });
    expect(JSON.stringify(entry)).not.toMatch(/123\.45|67\.89/);
  } finally {
    log.mockRestore();
  }
});

test('instância com worker desligado deixa a pendente como está', async () => {
  const w = await openWallet(admin, '100.00');
  const betInput = payload(w);
  const refund = await submitted(admin, referencing(w, betInput.externalTransactionId));
  await submitted(admin, betInput);
  await Bun.sleep(300);

  expect(await txRow(admin, refund.id)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 0 });
});

test('shutdown durante a espera de polling não aguarda o intervalo', async () => {
  const app = await start({ pendingReferencePollIntervalMs: 60_000 });
  await Bun.sleep(300); // primeiro lote (vazio) já rodou; o worker está dormindo

  const started = Date.now();
  running.splice(running.indexOf(app), 1);
  await app.close();

  expect(Date.now() - started).toBeLessThan(2000);
});
