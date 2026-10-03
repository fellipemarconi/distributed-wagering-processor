import { DomainError } from './errors';
import type { FailureCode } from './failure-code';
import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { MoneyProps } from './money';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Id, correlação e instante vêm de fora: o domínio não gera ids nem lê o relógio. */
export type EventContext = Omit<IntegrationEventProps<unknown>, 'aggregateId' | 'data'>;

export type IntegrationEventEnvelope<T> = {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = deepFreeze(props.data);
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

// data carrega MoneyProps (string decimal), nunca Money: o payload precisa ser JSON estável.

interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionData(tx: WagerTransaction): WagerTransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionData {
  referenceTransactionId?: string;
  processedAt: string; // ISO-8601
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.processedAt) throw new DomainError(`Transação ${tx.id} não está PROCESSED`);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...transactionData(tx),
        ...(tx.referenceTransactionId !== undefined && { referenceTransactionId: tx.referenceTransactionId }),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new DomainError(`Transação ${tx.id} não tem failureCode`);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), failureCode: tx.failureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.referenceExternalTransactionId === undefined) {
      throw new DomainError(`Transação ${tx.id} não informa referência`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
