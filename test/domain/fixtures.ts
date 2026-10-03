import { Money } from '../../src/domain/money';
import { computePayloadHash } from '../../src/domain/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const T1 = new Date('2026-07-29T15:00:01.000Z');

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export function walletWith(amount: string): Wallet {
  return Wallet.rehydrate({ id: 'w1', playerId: 'p1', balance: brl(amount), version: 1, createdAt: T0, updatedAt: T0 });
}

let seq = 0;
export const ctx = (transactionId = 'tx') => ({ entryId: `e${++seq}`, transactionId, at: T1 });

export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const kind = overrides.kind ?? Kind.Bet;
  const needsRef = kind === Kind.Refund || kind === Kind.Rollback;
  const base = {
    id: `tx-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind}`,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId: needsRef ? 'ext-BET' : undefined,
    createdAt: T0,
    ...overrides,
  };
  return {
    idempotencyKey: `${base.providerId}:${base.externalTransactionId}`,
    payloadHash: computePayloadHash({ ...base, money: base.money.toJSON() }),
    ...base,
  };
}

export const tx = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(txProps(overrides));

/** Transação já persistida em qualquer estado (ex.: a referência de um REFUND). */
export const stored = (overrides: Partial<WagerTransactionState> = {}) =>
  WagerTransaction.rehydrate({ ...txProps(overrides), status: Status.Processed, processedAt: T0, ...overrides });
