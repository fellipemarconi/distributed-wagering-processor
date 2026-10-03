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
  /** PENDING_REFERENCE vencidas (nunca tentadas primeiro). Não trava nada. */
  abstract findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  /**
   * Relê com FOR UPDATE SKIP LOCKED, só se ainda PENDING_REFERENCE e vencida; senão (ou se a linha
   * estiver travada) devolve undefined sem esperar. Exige transação aberta.
   */
  abstract claimPendingReference(id: string, now: Date): Promise<WagerTransaction | undefined>;
  /** UPDATE condicionado a status = PENDING_REFERENCE; lança se não afetar exatamente uma linha. */
  abstract savePendingReference(tx: WagerTransaction): Promise<void>;
  /** Torna vencidas em `now` as PENDING_REFERENCE do provider que aguardam este id externo. */
  abstract wakePendingReferencesOf(providerId: string, externalTransactionId: string, now: Date): Promise<void>;
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
  /**
   * Pendentes e vencidas, travadas com FOR UPDATE SKIP LOCKED até o fim da transação: outro
   * publisher recebe outras linhas em vez de esperar. Exige transação aberta.
   */
  abstract claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** occurredAt do evento não publicado mais antigo; undefined se não há pendentes. */
  abstract oldestPendingOccurredAt(): Promise<Date | undefined>;
}

/**
 * O destino dos eventos está fora do ar (conexão, timeout, 5xx, throttling) — o problema não é
 * a mensagem. Qualquer outro erro de `publish` é uma recusa àquela mensagem específica.
 */
export class EventPublisherUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Destino de eventos indisponível', options);
    this.name = 'EventPublisherUnavailableError';
  }
}

export abstract class EventPublisher {
  /** Resolve quando o destino aceitou a mensagem; rejeita caso contrário. */
  abstract publish(message: OutboxMessage): Promise<void>;
}

export abstract class TransactionRunner {
  /**
   * Tudo que os repositórios gravarem dentro de `work` é confirmado ou descartado junto.
   * Reentrante: um `run` dentro de outro participa da transação externa (savepoint) — só é
   * confirmado se a externa confirmar, e a falha dele desfaz só o que ele gravou.
   */
  abstract run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Somente leitura, em uma única foto do banco: todas as consultas de `work` enxergam o mesmo
   * instante confirmado. Não pede lock nem espera o de ninguém.
   */
  abstract snapshot<T>(work: () => Promise<T>): Promise<T>;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export abstract class Clock {
  abstract now(): Date;
}
