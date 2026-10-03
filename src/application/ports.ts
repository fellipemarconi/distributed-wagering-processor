import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

// Portas como classes abstratas: servem de tipo e de token de injeção ao mesmo tempo,
// sem depender de NestJS nem do ORM.

/** Gravação recusada por unicidade. `constraint` é o nome no schema (ex.: uq_wallets_player_currency). */
export class UniqueViolationError extends Error {
  constructor(
    public readonly constraint: string,
    options?: ErrorOptions,
  ) {
    super(`Violação de unicidade: ${constraint}`, options);
    this.name = 'UniqueViolationError';
  }
}

export abstract class WalletRepository {
  abstract add(wallet: Wallet): Promise<void>;
  abstract save(wallet: Wallet): Promise<void>;
  abstract findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE na linha da wallet. Exige transação aberta. */
  abstract findByIdForUpdate(id: string): Promise<Wallet | undefined>;
}

export abstract class WagerTransactionRepository {
  abstract add(tx: WagerTransaction): Promise<void>;
  abstract save(tx: WagerTransaction): Promise<void>;
  abstract findById(id: string): Promise<WagerTransaction | undefined>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND ou ROLLBACK em PROCESSED cuja referência resolvida é esta transação. */
  abstract hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Ausente na última página. */
  nextCursor?: string;
}

export abstract class LedgerRepository {
  /** Só INSERT: o ledger não tem save. */
  abstract append(entry: WalletLedgerEntry): Promise<void>;
  abstract listByWallet(walletId: string, page: { after?: string; limit: number }): Promise<LedgerPage>;
}

export abstract class InboxRepository {
  abstract add(message: InboxMessage): Promise<void>;
  abstract save(message: InboxMessage): Promise<void>;
  abstract find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export abstract class OutboxRepository {
  abstract add(message: OutboxMessage): Promise<void>;
  abstract save(message: OutboxMessage): Promise<void>;
  abstract findById(id: string): Promise<OutboxMessage | undefined>;
}

export abstract class TransactionRunner {
  /** Tudo que os repositórios gravarem dentro de `work` é confirmado ou descartado junto. */
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export abstract class Clock {
  abstract now(): Date;
}
