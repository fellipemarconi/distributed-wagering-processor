import { expect, test } from 'bun:test';
import { DomainError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from '../../src/domain/integration-events';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { brl, ctx, T1, tx, walletWith } from './fixtures';

const eventCtx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T1 };
const BRL_25 = { amount: '25.00', currency: 'BRL' };

function processedBet() {
  const bet = tx();
  bet.markProcessed(undefined, brl('75.00'), T1);
  return bet;
}

test('envelope serializado: campos, instante ISO-8601 e ida e volta por JSON', () => {
  const event = WagerTransactionProcessed.from(processedBet(), eventCtx);
  const json = event.toJSON();
  expect(json).toMatchObject({
    eventId: 'evt-1',
    eventType: 'WagerTransactionProcessed',
    aggregateId: 'tx-BET',
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt: '2026-07-29T15:00:01.000Z',
    version: 1,
  });
  expect(JSON.parse(JSON.stringify(event))).toEqual(json);
});

test('causationId ausente não aparece no envelope', () => {
  const { causationId: _omit, ...withoutCause } = eventCtx;
  const json = WagerTransactionProcessed.from(processedBet(), withoutCause).toJSON();
  expect('causationId' in json).toBe(false);
});

test('data é somente leitura, inclusive os valores monetários aninhados', () => {
  const event = WagerTransactionProcessed.from(processedBet(), eventCtx);
  const data = event.data as unknown as { kind: string; money: { amount: string } };
  expect(() => (data.kind = 'WIN')).toThrow(TypeError);
  expect(() => (data.money.amount = '999.00')).toThrow(TypeError);
});

test('WagerTransactionProcessed', () => {
  const refund = tx({ kind: Kind.Refund });
  refund.markProcessed('tx-BET', brl('100.00'), T1);
  const event = WagerTransactionProcessed.from(refund, eventCtx);
  expect(event.eventType).toBe('WagerTransactionProcessed');
  expect(event.version).toBe(1);
  expect(event.aggregateId).toBe(refund.id);
  expect(event.data).toEqual({
    transactionId: 'tx-REFUND',
    providerId: 'provider-a',
    externalTransactionId: 'ext-REFUND',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Refund,
    money: BRL_25,
    referenceTransactionId: 'tx-BET',
    processedAt: '2026-07-29T15:00:01.000Z',
  });
  expect(() => WagerTransactionProcessed.from(tx(), eventCtx)).toThrow(DomainError);
});

test('WagerTransactionRejected carrega o failureCode', () => {
  const bet = tx();
  bet.reject(FailureCode.InsufficientFunds, brl('10.00'), T1);
  const event = WagerTransactionRejected.from(bet, eventCtx);
  expect(event.eventType).toBe('WagerTransactionRejected');
  expect(event.version).toBe(1);
  expect(event.aggregateId).toBe(bet.id);
  expect(event.data).toMatchObject({ transactionId: bet.id, failureCode: 'INSUFFICIENT_FUNDS', money: BRL_25 });
  expect(() => WagerTransactionRejected.from(tx(), eventCtx)).toThrow(DomainError);
});

test('WagerTransactionPendingReference carrega a referência aguardada', () => {
  const refund = tx({ kind: Kind.Refund });
  refund.markPendingReference();
  const event = WagerTransactionPendingReference.from(refund, eventCtx);
  expect(event.eventType).toBe('WagerTransactionPendingReference');
  expect(event.version).toBe(1);
  expect(event.aggregateId).toBe(refund.id);
  expect(event.data).toMatchObject({ transactionId: refund.id, referenceExternalTransactionId: 'ext-BET' });
  expect(() => WagerTransactionPendingReference.from(tx(), eventCtx)).toThrow(DomainError);
});

test('WalletBalanceChanged tem a wallet como agregado e valores como MoneyProps', () => {
  const wallet = walletWith('1000.00');
  const entry = wallet.debit(brl('25'), ctx('tx-BET'));
  const event = WalletBalanceChanged.from(wallet, entry, eventCtx);
  expect(event.eventType).toBe('WalletBalanceChanged');
  expect(event.version).toBe(1);
  expect(event.aggregateId).toBe('w1');
  expect(event.data).toEqual({
    walletId: 'w1',
    transactionId: 'tx-BET',
    direction: LedgerDirection.Debit,
    money: BRL_25,
    balanceBefore: { amount: '1000.00', currency: 'BRL' },
    balanceAfter: { amount: '975.00', currency: 'BRL' },
    walletVersion: 2,
  });
});

test('nenhum evento carrega instância de Money', () => {
  const wallet = walletWith('1000.00');
  const events = [
    WagerTransactionProcessed.from(processedBet(), eventCtx),
    WalletBalanceChanged.from(wallet, wallet.debit(brl('25'), ctx()), eventCtx),
  ];
  for (const event of events) {
    for (const value of Object.values(event.data)) expect(value).not.toBeInstanceOf(Money);
    expect(JSON.stringify(event)).toContain('{"amount":"25.00","currency":"BRL"}');
  }
});
