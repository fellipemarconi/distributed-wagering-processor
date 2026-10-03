import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { InvalidPayloadError } from '../../src/application/input';
import { OutboxRepository, WagerTransactionRepository } from '../../src/application/ports';
import type { Wallet } from '../../src/domain/wallet';
import { sql } from '../persistence/helpers';
import {
  balanceOf,
  boot,
  countRows,
  eventsOf,
  expectLedgerInvariant,
  ledgerOf,
  openWallet,
  payload,
  submit,
  submitted,
  uuid,
} from './helpers';

const app = await boot();
afterAll(() => app.close());

// Invariante final de todo teste: cada wallet aberta é conferida contra o próprio ledger.
const opened: Wallet[] = [];
async function wallet(amount = '100.00', currency = 'BRL', from: INestApplication = app): Promise<Wallet> {
  const w = await openWallet(from, amount, currency);
  opened.push(w);
  return w;
}
afterEach(async () => {
  for (const w of opened.splice(0)) await expectLedgerInvariant(app, w.id);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const state = async (w: Wallet) => ({ balance: await balanceOf(app, w.id), entries: (await ledgerOf(app, w.id)).length });
/** Lançamentos além do de abertura. */
const movements = async (w: Wallet) => (await ledgerOf(app, w.id)).slice(1).map((e) => `${e.direction} ${e.amount}`);

/** BET aplicada, pronta para ser referenciada. */
async function bet(w: Wallet, amount = '25.00', overrides: Record<string, unknown> = {}) {
  const input = payload(w, { money: brl(amount), ...overrides });
  const tx = await submitted(app, input);
  expect(tx.status).toBe('PROCESSED');
  return { input, tx };
}
const referencing = (w: Wallet, kind: string, reference: { externalTransactionId: string }, amount = '25.00') =>
  payload(w, { kind, money: brl(amount), referenceExternalTransactionId: reference.externalTransactionId });

describe('regras da seção 7', () => {
  test('BET debita: PROCESSED, um DEBIT, version incrementa', async () => {
    const w = await wallet('1000.00');

    const result = await submit(app, payload(w));

    if (result.outcome !== 'processed') throw new Error(result.outcome);
    expect(result.transaction.resultBalance!.toJSON()).toEqual(brl('975.00'));
    expect(await ledgerOf(app, w.id)).toEqual([
      expect.objectContaining({ direction: 'CREDIT' }),
      { direction: 'DEBIT', amount: '25.00', balance_before: '1000.00', balance_after: '975.00', transaction_id: result.transaction.id },
    ]);
    expect(await balanceOf(app, w.id)).toBe('975.00');
    expect(await countRows(app, 'wallets', 'id = ? and version = 2', [w.id])).toBe(1);
  });

  test('WIN credita, com ou sem referência à BET', async () => {
    const w = await wallet();
    const { input } = await bet(w);

    expect((await submitted(app, payload(w, { kind: 'WIN', money: brl('50.00') }))).status).toBe('PROCESSED');
    const referenced = await submitted(app, referencing(w, 'WIN', input, '10.00'));

    expect(referenced.status).toBe('PROCESSED');
    expect(await movements(w)).toEqual(['DEBIT 25.00', 'CREDIT 50.00', 'CREDIT 10.00']);
    expect(await balanceOf(app, w.id)).toBe('135.00');
  });

  test('LOSS é PROCESSED sem lançamento, saldo e version inalterados', async () => {
    const w = await wallet();

    const tx = await submitted(app, payload(w, { kind: 'LOSS', money: brl('0.00') }));

    expect(tx.status).toBe('PROCESSED');
    expect(tx.resultBalance!.toJSON()).toEqual(brl('100.00'));
    expect(await state(w)).toEqual({ balance: '100.00', entries: 1 });
    expect(await countRows(app, 'wallets', 'id = ? and version = 1', [w.id])).toBe(1);
  });

  test('REFUND de BET aplicada credita e devolve o saldo anterior à aposta', async () => {
    const w = await wallet();
    const { input, tx: betTx } = await bet(w);

    const refund = await submitted(app, referencing(w, 'REFUND', input));

    expect(refund.status).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(betTx.id);
    expect(await movements(w)).toEqual(['DEBIT 25.00', 'CREDIT 25.00']);
    expect(await balanceOf(app, w.id)).toBe('100.00');
  });

  test('ROLLBACK de BET credita', async () => {
    const w = await wallet();
    const { input } = await bet(w);

    expect((await submitted(app, referencing(w, 'ROLLBACK', input))).status).toBe('PROCESSED');

    expect(await movements(w)).toEqual(['DEBIT 25.00', 'CREDIT 25.00']);
  });

  test('ROLLBACK de WIN debita', async () => {
    const w = await wallet();
    const win = payload(w, { kind: 'WIN', money: brl('50.00') });
    await submitted(app, win);

    expect((await submitted(app, referencing(w, 'ROLLBACK', win, '50.00'))).status).toBe('PROCESSED');

    expect(await movements(w)).toEqual(['CREDIT 50.00', 'DEBIT 50.00']);
    expect(await balanceOf(app, w.id)).toBe('100.00');
  });

  test('BET maior que o saldo: REJECTED INSUFFICIENT_FUNDS, sem lançamento', async () => {
    const w = await wallet('20.00');

    const result = await submit(app, payload(w, { money: brl('80.00') }));

    if (result.outcome !== 'rejected') throw new Error(result.outcome);
    expect(result.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.transaction.resultBalance!.toJSON()).toEqual(brl('20.00'));
    expect(await state(w)).toEqual({ balance: '20.00', entries: 1 });
  });

  test('ROLLBACK de WIN já gasto: REJECTED REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const w = await wallet('0.00');
    const win = payload(w, { kind: 'WIN', money: brl('50.00') });
    await submitted(app, win);
    await bet(w, '40.00');

    const rollback = await submitted(app, referencing(w, 'ROLLBACK', win, '50.00'));

    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    // wallet aberta com zero não tem lançamento de abertura: o ledger inteiro são estes dois
    expect((await ledgerOf(app, w.id)).map((e) => `${e.direction} ${e.amount}`)).toEqual(['CREDIT 50.00', 'DEBIT 40.00']);
    expect(await balanceOf(app, w.id)).toBe('10.00');
  });

  test('jogador diferente do dono: REJECTED WALLET_PLAYER_MISMATCH', async () => {
    const w = await wallet();

    const tx = await submitted(app, payload(w, { playerId: uuid() }));

    expect([tx.status, tx.failureCode]).toEqual(['REJECTED', 'WALLET_PLAYER_MISMATCH']);
    expect(await state(w)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('moeda diferente da wallet: REJECTED CURRENCY_MISMATCH', async () => {
    const w = await wallet();

    const tx = await submitted(app, payload(w, { money: { amount: '5.00', currency: 'USD' } }));

    expect([tx.status, tx.failureCode]).toEqual(['REJECTED', 'CURRENCY_MISMATCH']);
    expect(tx.resultBalance!.toJSON()).toEqual(brl('100.00'));
    expect(await state(w)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('jogador é verificado antes da moeda', async () => {
    const w = await wallet();

    const tx = await submitted(app, payload(w, { playerId: uuid(), money: { amount: '5.00', currency: 'USD' } }));

    expect(tx.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('REFUND de outra rodada: REFERENCE_MISMATCH', async () => {
    const w = await wallet();
    const { input } = await bet(w);

    const refund = await submitted(app, { ...referencing(w, 'REFUND', input), roundId: 'round-2' });

    expect([refund.status, refund.failureCode]).toEqual(['REJECTED', 'REFERENCE_MISMATCH']);
    expect(await balanceOf(app, w.id)).toBe('75.00');
  });

  test('REFUND de um WIN: REFERENCE_KIND_NOT_ALLOWED', async () => {
    const w = await wallet();
    const win = payload(w, { kind: 'WIN' });
    await submitted(app, win);

    const refund = await submitted(app, referencing(w, 'REFUND', win));

    expect([refund.status, refund.failureCode]).toEqual(['REJECTED', 'REFERENCE_KIND_NOT_ALLOWED']);
  });

  test('REFUND de BET rejeitada: REFERENCE_NOT_PROCESSED', async () => {
    const w = await wallet('10.00');
    const rejectedBet = payload(w);
    expect((await submitted(app, rejectedBet)).status).toBe('REJECTED');

    const refund = await submitted(app, referencing(w, 'REFUND', rejectedBet));

    expect([refund.status, refund.failureCode]).toEqual(['REJECTED', 'REFERENCE_NOT_PROCESSED']);
    expect(await state(w)).toEqual({ balance: '10.00', entries: 1 });
  });

  test.each(['REFUND', 'ROLLBACK'])('segunda reversão (%s) da mesma BET: REFERENCE_ALREADY_REVERSED', async (second) => {
    const w = await wallet();
    const { input } = await bet(w);
    expect((await submitted(app, referencing(w, 'REFUND', input))).status).toBe('PROCESSED');

    const again = await submitted(app, referencing(w, second, input));

    expect([again.status, again.failureCode]).toEqual(['REJECTED', 'REFERENCE_ALREADY_REVERSED']);
    expect(await movements(w)).toEqual(['DEBIT 25.00', 'CREDIT 25.00']);
    expect(await balanceOf(app, w.id)).toBe('100.00');
  });

  test('REFUND com valor diferente da BET: REFERENCE_AMOUNT_MISMATCH', async () => {
    const w = await wallet();
    const { input } = await bet(w);

    const refund = await submitted(app, referencing(w, 'REFUND', input, '10.00'));

    expect([refund.status, refund.failureCode]).toEqual(['REJECTED', 'REFERENCE_AMOUNT_MISMATCH']);
    expect(await balanceOf(app, w.id)).toBe('75.00');
  });
});

describe('entrada inválida e wallet inexistente', () => {
  const externalId = (input: { externalTransactionId: string }) =>
    countRows(app, 'wager_transactions', 'external_transaction_id = ?', [input.externalTransactionId]);

  test.each([
    ['OPENING', { kind: 'OPENING' }],
    ['kind desconhecido', { kind: 'BONUS' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['BET com referência', { referenceExternalTransactionId: 'x' }],
    ['BET de valor zero', { money: brl('0.00') }],
    ['valor negativo', { money: brl('-1.00') }],
    ['valor com 3 casas', { money: brl('1.005') }],
    ['valor numérico', { money: { amount: 25, currency: 'BRL' } }],
    ['provedor reservado', { providerId: 'internal' }],
    ['walletId não UUID', { walletId: 'w1' }],
    ['campo obrigatório ausente', { roundId: undefined }],
    ['chave de idempotência vazia', { idempotencyKey: '' }],
  ])('%s é recusado sem gravar nada', async (_name, overrides) => {
    const w = await wallet();
    const input = { ...payload(w), ...overrides };

    await expect(submit(app, input)).rejects.toBeInstanceOf(InvalidPayloadError);

    expect(await externalId(input)).toBe(0);
    expect(await state(w)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('campos desconhecidos são ignorados', async () => {
    const w = await wallet();
    expect((await submitted(app, { ...payload(w), extra: 'x' })).status).toBe('PROCESSED');
  });

  test('wallet inexistente: not-found, sem transação nem evento', async () => {
    const outboxBefore = await countRows(app, 'outbox_messages', 'true', []);
    const input = payload({ id: uuid(), playerId: uuid() });

    expect(await submit(app, input)).toEqual({ outcome: 'not-found' });

    expect(await externalId(input)).toBe(0);
    expect(await countRows(app, 'outbox_messages', 'true', [])).toBe(outboxBefore);
  });
});

describe('idempotência', () => {
  test('replay de aplicada devolve o saldo observado na época, não o atual', async () => {
    const w = await wallet('1000.00');
    const { input, tx } = await bet(w);
    await bet(w, '100.00');

    const replay = await submit(app, input);

    if (replay.outcome !== 'replay') throw new Error(replay.outcome);
    expect(replay.transaction.id).toBe(tx.id);
    expect(replay.transaction.status).toBe('PROCESSED');
    expect(replay.transaction.resultBalance!.toJSON()).toEqual(brl('975.00'));
    expect(await state(w)).toEqual({ balance: '875.00', entries: 3 });
  });

  test('replay de rejeitada não reavalia a aposta', async () => {
    const w = await wallet('10.00');
    const input = payload(w, { money: brl('80.00') });
    const rejected = await submitted(app, input);
    await submitted(app, payload(w, { kind: 'WIN', money: brl('500.00') }));

    const replay = await submit(app, input);

    if (replay.outcome !== 'replay') throw new Error(replay.outcome);
    expect(replay.transaction.id).toBe(rejected.id);
    expect([replay.transaction.status, replay.transaction.failureCode]).toEqual(['REJECTED', 'INSUFFICIENT_FUNDS']);
    expect(replay.transaction.resultBalance!.toJSON()).toEqual(brl('10.00'));
    expect(await balanceOf(app, w.id)).toBe('510.00');
  });

  test('replay de pendente continua pendente e não gera evento novo', async () => {
    const w = await wallet();
    const input = referencing(w, 'REFUND', { externalTransactionId: uuid() });
    const pending = await submitted(app, input);

    const replay = await submit(app, input);

    if (replay.outcome !== 'replay') throw new Error(replay.outcome);
    expect(replay.transaction.status).toBe('PENDING_REFERENCE');
    expect(await eventsOf(app, pending.id)).toEqual(['WagerTransactionPendingReference']);
  });

  test('mesma chave com payload diferente é conflito de chave, não replay', async () => {
    const w = await wallet();
    const { input, tx } = await bet(w);

    const result = await submit(app, { ...input, money: brl('30.00') });

    expect(result).toEqual({ outcome: 'conflict', code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await state(w)).toEqual({ balance: '75.00', entries: 2 });
    expect((await app.get(WagerTransactionRepository).findById(tx.id))!.money.toJSON()).toEqual(brl('25.00'));
  });

  test('mesmo id externo com outra chave é conflito de transação externa', async () => {
    const w = await wallet();
    const { input } = await bet(w);

    const result = await submit(app, { ...input, idempotencyKey: uuid() });

    expect(result).toEqual({ outcome: 'conflict', code: 'EXTERNAL_TRANSACTION_CONFLICT' });
    expect(await state(w)).toEqual({ balance: '75.00', entries: 2 });
  });

  test('"25" e "25.00" são o mesmo payload', async () => {
    const w = await wallet();
    const { input } = await bet(w);

    expect((await submit(app, { ...input, money: brl('25') })).outcome).toBe('replay');
  });
});

describe('referência ausente', () => {
  test('REFUND antes da BET fica PENDING_REFERENCE, sem lançamento', async () => {
    const w = await wallet();

    const result = await submit(app, referencing(w, 'REFUND', { externalTransactionId: uuid() }));

    if (result.outcome !== 'pending') throw new Error(result.outcome);
    expect(result.transaction.status).toBe('PENDING_REFERENCE');
    expect(result.transaction.resultBalance).toBeUndefined();
    expect(await state(w)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('WIN com referência ainda não recebida fica PENDING_REFERENCE', async () => {
    const w = await wallet();

    const tx = await submitted(app, referencing(w, 'WIN', { externalTransactionId: uuid() }));

    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(await state(w)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('REFUND de referência ainda pendente também aguarda', async () => {
    const w = await wallet();
    const pendingWin = referencing(w, 'WIN', { externalTransactionId: uuid() });
    await submitted(app, pendingWin);

    const rollback = await submitted(app, referencing(w, 'ROLLBACK', pendingWin));

    expect(rollback.status).toBe('PENDING_REFERENCE');
  });
});

describe('outbox', () => {
  test('aplicada com mudança de saldo: Processed + BalanceChanged', async () => {
    const w = await wallet();
    const { tx } = await bet(w);
    expect(await eventsOf(app, tx.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('LOSS: só Processed', async () => {
    const w = await wallet();
    const tx = await submitted(app, payload(w, { kind: 'LOSS' }));
    expect(await eventsOf(app, tx.id)).toEqual(['WagerTransactionProcessed']);
  });

  test('rejeição: só Rejected', async () => {
    const w = await wallet('1.00');
    const tx = await submitted(app, payload(w));
    expect(await eventsOf(app, tx.id)).toEqual(['WagerTransactionRejected']);
  });

  test('pendência: só PendingReference', async () => {
    const w = await wallet();
    const tx = await submitted(app, referencing(w, 'REFUND', { externalTransactionId: uuid() }));
    expect(await eventsOf(app, tx.id)).toEqual(['WagerTransactionPendingReference']);
  });

  test('replay e conflito não enfileiram nada', async () => {
    const w = await wallet();
    const { input, tx } = await bet(w);
    const total = () => countRows(app, 'outbox_messages', 'aggregate_id in (?, ?)', [tx.id, w.id]);
    const before = await total();

    await submit(app, input);
    await submit(app, { ...input, money: brl('30.00') });
    await submit(app, { ...input, idempotencyKey: uuid() });

    expect(await total()).toBe(before);
  });

  test('evento carrega correlationId, dinheiro como string e nada é marcado como publicado', async () => {
    const w = await wallet();
    const { tx } = await bet(w);

    const changed = (await app.get(OutboxRepository).findById((await outboxIds(w.id))[1]!))!;

    expect(changed.isPending()).toBe(true);
    expect(changed.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateId: w.id,
      correlationId: expect.any(String),
      data: { transactionId: tx.id, direction: 'DEBIT', money: brl('25.00'), balanceAfter: brl('75.00'), walletVersion: 2 },
    });
  });
});

async function outboxIds(aggregateId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>(
    app.get(MikroORM),
    'select id from outbox_messages where aggregate_id = ? order by occurred_at, id',
    [aggregateId],
  );
  return rows.map((r) => r.id);
}

describe('atomicidade', () => {
  test('falha depois de inserir a transação desfaz transação, lançamento e saldo', async () => {
    // falha injetada na última gravação (outbox); Postgres e demais repositórios são os reais
    const failing = await boot({}, (b) =>
      b.overrideProvider(OutboxRepository).useValue({ add: () => Promise.reject(new Error('outbox fora')) }),
    );
    try {
      const w = await wallet('0.00', 'BRL', failing); // saldo zero: abertura não usa a outbox
      const input = payload(w, { kind: 'WIN' });

      await expect(submit(failing, input)).rejects.toThrow('outbox fora');

      expect(await countRows(app, 'wager_transactions', 'external_transaction_id = ?', [input.externalTransactionId])).toBe(0);
      expect(await state(w)).toEqual({ balance: '0.00', entries: 0 });
      expect(await countRows(app, 'wallets', 'id = ? and version = 1', [w.id])).toBe(1);
    } finally {
      await failing.close();
    }
  });
});
