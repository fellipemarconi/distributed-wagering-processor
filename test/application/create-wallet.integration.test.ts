import { afterAll, expect, test } from 'bun:test';
import { CreateWallet } from '../../src/application/create-wallet';
import { InvalidPayloadError } from '../../src/application/input';
import { boot, countRows, ctx, eventsOf, expectLedgerInvariant, ledgerOf, uuid } from './helpers';

const app = await boot();
afterAll(() => app.close());
const createWallet = app.get(CreateWallet);

const create = (playerId: string, amount: string, currency = 'BRL') =>
  createWallet.execute({ playerId, initialBalance: { amount, currency } }, ctx());

const openings = (walletId: string) => countRows(app, 'wager_transactions', 'wallet_id = ?', [walletId]);

test('saldo inicial positivo: wallet v1 + OPENING processada + CREDIT + dois eventos', async () => {
  const result = await create(uuid(), '1000.00');

  if (result.outcome !== 'created') throw new Error(result.outcome);
  const { wallet } = result;
  expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
  expect(wallet.version).toBe(1);

  const ledger = await ledgerOf(app, wallet.id);
  expect(ledger).toEqual([
    { direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00', transaction_id: ledger[0]!.transaction_id },
  ]);
  expect(await countRows(app, 'wager_transactions', "wallet_id = ? and kind = 'OPENING' and status = 'PROCESSED'", [wallet.id])).toBe(1);
  expect(await eventsOf(app, ledger[0]!.transaction_id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  await expectLedgerInvariant(app, wallet.id);
});

test('saldo inicial zero: só a wallet, sem transação, lançamento ou evento', async () => {
  const result = await create(uuid(), '0.00');

  if (result.outcome !== 'created') throw new Error(result.outcome);
  expect(result.wallet.balance.toJSON().amount).toBe('0.00');
  expect(await ledgerOf(app, result.wallet.id)).toEqual([]);
  expect(await openings(result.wallet.id)).toBe(0);
  expect(await countRows(app, 'outbox_messages', 'aggregate_id = ?', [result.wallet.id])).toBe(0);
  await expectLedgerInvariant(app, result.wallet.id);
});

test('mesmo jogador e moeda é conflito e não grava nada', async () => {
  const playerId = uuid();
  const first = await create(playerId, '10.00');

  expect(await create(playerId, '50.00')).toEqual({ outcome: 'conflict' });

  expect(await countRows(app, 'wallets', 'player_id = ?', [playerId])).toBe(1);
  expect(await countRows(app, 'wager_transactions', 'player_id = ?', [playerId])).toBe(1);
  if (first.outcome !== 'created') throw new Error(first.outcome);
  await expectLedgerInvariant(app, first.wallet.id);
});

test('criações concorrentes: exatamente uma criada, as demais conflito', async () => {
  const playerId = uuid();

  const results = await Promise.all(Array.from({ length: 10 }, () => create(playerId, '10.00')));

  expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
  expect(results.filter((r) => r.outcome === 'conflict')).toHaveLength(9);
  expect(await countRows(app, 'wallets', 'player_id = ?', [playerId])).toBe(1);
  expect(await countRows(app, 'wager_transactions', 'player_id = ?', [playerId])).toBe(1);
  const created = results.find((r) => r.outcome === 'created')!;
  await expectLedgerInvariant(app, created.wallet.id);
});

test('mesmo jogador em outra moeda é aceito', async () => {
  const playerId = uuid();
  await create(playerId, '10.00', 'BRL');

  const usd = await create(playerId, '10.00', 'USD');

  if (usd.outcome !== 'created') throw new Error(usd.outcome);
  await expectLedgerInvariant(app, usd.wallet.id);
});

test('entrada inválida lança InvalidPayloadError e não grava', async () => {
  const playerId = uuid();
  for (const amount of ['-1.00', '10.005', '1e3', 10]) {
    await expect(createWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' } }, ctx())).rejects.toBeInstanceOf(InvalidPayloadError);
  }
  await expect(createWallet.execute({ initialBalance: { amount: '1.00', currency: 'BRL' } }, ctx())).rejects.toBeInstanceOf(InvalidPayloadError);
  expect(await countRows(app, 'wallets', 'player_id = ?', [playerId])).toBe(0);
});
