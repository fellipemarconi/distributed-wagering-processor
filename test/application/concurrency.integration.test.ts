import { afterAll, expect, test } from 'bun:test';
import { balanceOf, boot, countRows, expectLedgerInvariant, ledgerOf, openWallet, payload, submit } from './helpers';

// Paralelismo real: cada execute() abre a própria transação em uma conexão do pool (10 por padrão);
// o que serializa é o FOR UPDATE na linha da wallet, não a aplicação.
const app = await boot();
afterAll(() => app.close());

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const debits = async (walletId: string) => (await ledgerOf(app, walletId)).filter((e) => e.direction === 'DEBIT');

test('seção 8: saldo 100.00, duas BET de 80.00 em paralelo → uma PROCESSED, uma REJECTED, saldo 20.00, um DEBIT', async () => {
  const w = await openWallet(app, '100.00');

  const results = await Promise.all([
    submit(app, payload(w, { money: brl('80.00') })),
    submit(app, payload(w, { money: brl('80.00') })),
  ]);

  expect(results.map((r) => r.outcome).sort()).toEqual(['processed', 'rejected']);
  const rejected = results.find((r) => r.outcome === 'rejected');
  expect(rejected).toMatchObject({ transaction: { failureCode: 'INSUFFICIENT_FUNDS' } });
  expect(await balanceOf(app, w.id)).toBe('20.00');
  expect(await debits(w.id)).toHaveLength(1);
  await expectLedgerInvariant(app, w.id);
});

test('mesma BET 50 vezes em paralelo → um débito, 49 replays, nenhum erro', async () => {
  const w = await openWallet(app, '100.00');
  const input = payload(w, { money: brl('30.00') });

  // allSettled: uma rejeição (ex.: lock_timeout → 503 no HTTP) apareceria aqui em vez de abortar o teste
  const settled = await Promise.allSettled(Array.from({ length: 50 }, () => submit(app, input)));

  expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
  const results = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof submit>>>).value);
  expect(results.filter((r) => r.outcome === 'processed')).toHaveLength(1);
  expect(results.filter((r) => r.outcome === 'replay')).toHaveLength(49);

  // todos devolvem a mesma transação e o mesmo saldo observado
  const seen = results.map((r) => ('transaction' in r ? `${r.transaction.id} ${r.transaction.status} ${r.transaction.resultBalance}` : r.outcome));
  expect(new Set(seen).size).toBe(1);
  expect(seen[0]).toEndWith('PROCESSED 70.00 BRL');

  expect(await balanceOf(app, w.id)).toBe('70.00');
  expect(await debits(w.id)).toHaveLength(1);
  expect(await countRows(app, 'wager_transactions', 'external_transaction_id = ?', [input.externalTransactionId])).toBe(1);
  await expectLedgerInvariant(app, w.id);
});

test('wallets distintas em paralelo não interferem entre si', async () => {
  const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet(app, '100.00')));

  // 5 apostas de 10.00 por wallet, todas misturadas
  const results = await Promise.all(
    wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(app, payload(w, { money: brl('10.00') })))),
  );

  expect(results.every((r) => r.outcome === 'processed')).toBe(true);
  for (const w of wallets) {
    expect(await balanceOf(app, w.id)).toBe('50.00');
    expect(await debits(w.id)).toHaveLength(5);
    await expectLedgerInvariant(app, w.id);
  }
});

test('apostas concorrentes além do saldo: nunca negativo, aplicadas + rejeitadas fecham a conta', async () => {
  const w = await openWallet(app, '100.00');

  const results = await Promise.all(Array.from({ length: 20 }, () => submit(app, payload(w, { money: brl('15.00') }))));

  expect(results.filter((r) => r.outcome === 'processed')).toHaveLength(6); // 6 × 15.00 = 90.00
  expect(results.filter((r) => r.outcome === 'rejected')).toHaveLength(14);
  expect(await balanceOf(app, w.id)).toBe('10.00');
  expect(await debits(w.id)).toHaveLength(6);
  await expectLedgerInvariant(app, w.id);
});

test('mesma chave em wallets diferentes (corrida fora do lock): uma gravada, outra conflito, sem erro interno', async () => {
  for (let round = 0; round < 10; round++) {
    const [a, b] = await Promise.all([openWallet(app), openWallet(app)]);
    const first = payload(a);
    // mesma chave e mesmo id externo, wallet (e portanto payload) diferente
    const second = { ...payload(b), externalTransactionId: first.externalTransactionId, idempotencyKey: first.idempotencyKey };

    const results = await Promise.all([submit(app, first), submit(app, second)]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['conflict', 'processed']);
    expect(results.find((r) => r.outcome === 'conflict')).toEqual({ outcome: 'conflict', code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await countRows(app, 'wager_transactions', 'external_transaction_id = ?', [first.externalTransactionId])).toBe(1);
    await expectLedgerInvariant(app, a.id);
    await expectLedgerInvariant(app, b.id);
  }
});

test('reversões concorrentes da mesma BET: só uma é aplicada', async () => {
  const w = await openWallet(app, '100.00');
  const bet = payload(w);
  await submit(app, bet);
  const reversal = (kind: string) => payload(w, { kind, referenceExternalTransactionId: bet.externalTransactionId });

  const results = await Promise.all([
    submit(app, reversal('REFUND')),
    submit(app, reversal('ROLLBACK')),
    submit(app, reversal('REFUND')),
  ]);

  expect(results.map((r) => r.outcome).sort()).toEqual(['processed', 'rejected', 'rejected']);
  expect(await balanceOf(app, w.id)).toBe('100.00');
  await expectLedgerInvariant(app, w.id);
});
