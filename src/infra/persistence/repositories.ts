import { Injectable, Optional } from '@nestjs/common';
import { IsolationLevel, LockMode, QueryOrder, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  UniqueViolationError,
  WagerTransactionRepository,
  WalletRepository,
  type LedgerPage,
} from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { Metrics } from '../../observability/metrics';
import { sqlStateOf } from './transient-error';
import {
  inboxMessageMapper,
  ledgerEntryMapper,
  outboxMessageMapper,
  wagerTransactionMapper,
  walletMapper,
} from './mappers';
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './schemas';

// Escrita com em.insert / em.nativeUpdate (efeito imediato): o erro de constraint aparece na
// chamada que o causou, não no commit. O EM injetado resolve sozinho a transação aberta por
// TransactionRunner.run (AsyncLocalStorage).
//
// Leitura sempre com disableIdentityMap: nenhum registro fica em cache, então uma leitura com
// FOR UPDATE devolve o que está no banco depois de obter o lock, nunca uma instância já carregada.
const FRESH = { disableIdentityMap: true } as const;

/** Só unicidade é traduzida; CHECK/FK/trigger indicam bug e estouram como vieram. */
async function write(op: Promise<unknown>): Promise<void> {
  try {
    await op;
  } catch (error) {
    if (error instanceof UniqueConstraintViolationException) {
      throw new UniqueViolationError((error as { constraint?: string }).constraint ?? 'unknown', { cause: error });
    }
    throw error;
  }
}

/** Zero linhas afetadas é agregado inexistente — erro, não no-op silencioso. */
async function updateOne(op: Promise<number>, what: string): Promise<void> {
  const affected = await op;
  if (affected !== 1) throw new Error(`${what}: esperava atualizar 1 linha, atualizou ${affected}`);
}

const duePendingReference = (now: Date) => ({
  status: WagerTransactionStatus.PendingReference,
  $or: [{ nextReferenceAttemptAt: null }, { nextReferenceAttemptAt: { $lte: now } }],
});

const LOCK_CONFLICT_BY_SQLSTATE: Record<string, string> = { '55P03': 'lock_timeout', '40P01': 'deadlock' };
// Corridas que o lock da wallet não serializa e a unicidade decide. Constraint nova de idempotência
// entra aqui. uq_wallets_player_currency fica de fora: wallet duplicada é conflito de negócio.
const RACE_CONSTRAINTS = ['uq_wager_tx_provider_idempotency_key', 'uq_wager_tx_provider_external', 'pk_inbox_messages'];

@Injectable()
export class MikroOrmTransactionRunner extends TransactionRunner {
  /** `run` é reentrante: o mesmo erro atravessa o interno e o externo, e conta uma vez só. */
  private readonly counted = new WeakSet<object>();

  constructor(
    private readonly em: EntityManager,
    // opcional: o PersistenceModule também sobe sozinho, sem o módulo de métricas
    @Optional() private readonly metrics?: Metrics,
  ) {
    super();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(() => work());
    } catch (error) {
      this.countLockConflict(error);
      throw error;
    }
  }

  // REPEATABLE READ no PostgreSQL é snapshot isolation; somente leitura, não sofre falha de
  // serialização e o banco recusa qualquer escrita.
  snapshot<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => work(), { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  }

  private countLockConflict(error: unknown): void {
    if (!(error instanceof Error) || this.counted.has(error)) return;
    const type =
      error instanceof UniqueViolationError
        ? RACE_CONSTRAINTS.includes(error.constraint) && 'unique_violation'
        : LOCK_CONFLICT_BY_SQLSTATE[sqlStateOf(error) ?? ''];
    if (!type) return;
    this.counted.add(error);
    this.metrics?.lockConflicts.inc({ type });
  }
}

@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  add(wallet: Wallet): Promise<void> {
    return write(this.em.insert(WalletSchema, walletMapper.toRecord(wallet)));
  }

  save(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = walletMapper.toRecord(wallet);
    return updateOne(
      this.em.nativeUpdate(WalletSchema, { id: wallet.id }, { balance, version, updatedAt }),
      `wallet ${wallet.id}`,
    );
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, FRESH);
    return record ? walletMapper.toDomain(record) : undefined;
  }

  // Lock de linha: wallets diferentes não se bloqueiam. O MikroORM lança se não houver transação.
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletMapper.toDomain(record) : undefined;
  }
}

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  add(tx: WagerTransaction): Promise<void> {
    return write(this.em.insert(WagerTransactionSchema, wagerTransactionMapper.toRecord(tx)));
  }

  save(tx: WagerTransaction): Promise<void> {
    // pode violar uq_wager_tx_processed_reversal (segunda reversão aplicada em corrida)
    return write(
      updateOne(
        this.em.nativeUpdate(WagerTransactionSchema, { id: tx.id }, wagerTransactionMapper.toMutableRecord(tx)),
        `transação ${tx.id}`,
      ),
    );
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  // mesmo predicado do índice parcial uq_wager_tx_processed_reversal
  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      {
        referenceTransactionId,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
        status: WagerTransactionStatus.Processed,
      },
      { ...FRESH, fields: ['id'] },
    );
    return record !== null;
  }

  // filtro e ordem de ix_wager_tx_pending_reference_due
  async findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const records = await this.em.find(WagerTransactionSchema, duePendingReference(now), {
      ...FRESH,
      fields: ['id', 'walletId'],
      orderBy: { nextReferenceAttemptAt: QueryOrder.ASC_NULLS_FIRST },
      limit,
    });
    return records.map(({ id, walletId }) => ({ id, walletId }));
  }

  // O filtro é reavaliado depois do lock da wallet: quem perdeu a corrida encontra a transação
  // terminal ou reagendada e recebe undefined. SKIP LOCKED: nunca espera pela linha.
  async claimPendingReference(id: string, now: Date): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { id, ...duePendingReference(now) },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return record ? wagerTransactionMapper.toDomain(record) : undefined;
  }

  savePendingReference(tx: WagerTransaction): Promise<void> {
    return write(
      updateOne(
        this.em.nativeUpdate(
          WagerTransactionSchema,
          { id: tx.id, status: WagerTransactionStatus.PendingReference },
          wagerTransactionMapper.toMutableRecord(tx),
        ),
        `transação pendente ${tx.id}`,
      ),
    );
  }

  // ponytail: o predicado de status usa o índice parcial das pendentes (conjunto pequeno em regime);
  // criar índice parcial por (provider_id, reference_external_transaction_id) se ele crescer.
  async wakePendingReferencesOf(providerId: string, externalTransactionId: string, now: Date): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
      },
      { nextReferenceAttemptAt: now },
    );
  }

  private async findOne(where: Record<string, string>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, FRESH);
    return record ? wagerTransactionMapper.toDomain(record) : undefined;
  }
}

@Injectable()
export class MikroOrmLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  append(entry: WalletLedgerEntry): Promise<void> {
    return write(this.em.insert(LedgerEntrySchema, ledgerEntryMapper.toRecord(entry)));
  }

  // Cursor = seq do último lançamento devolvido. Por wallet, a ordem de seq é a ordem de commit
  // (todo lançamento é gravado com a wallet travada), então nada "aparece no passado".
  async listByWallet(walletId: string, page: { after?: string; limit: number }): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntrySchema,
      { walletId, ...(page.after !== undefined && { seq: { $gt: page.after } }) },
      // um a mais para saber se existe próxima página
      { ...FRESH, orderBy: { seq: 'asc' }, limit: page.limit + 1 },
    );
    const pageRecords = records.slice(0, page.limit);
    return {
      entries: pageRecords.map(ledgerEntryMapper.toDomain),
      nextCursor: records.length > page.limit ? pageRecords.at(-1)!.seq : undefined,
    };
  }
}

@Injectable()
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  add(message: InboxMessage): Promise<void> {
    return write(this.em.insert(InboxMessageSchema, inboxMessageMapper.toRecord(message)));
  }

  save(message: InboxMessage): Promise<void> {
    const { consumerName, messageId, processedAt } = inboxMessageMapper.toRecord(message);
    return updateOne(
      this.em.nativeUpdate(InboxMessageSchema, { consumerName, messageId }, { processedAt }),
      `inbox ${consumerName}/${messageId}`,
    );
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, FRESH);
    return record ? inboxMessageMapper.toDomain(record) : undefined;
  }
}

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  add(message: OutboxMessage): Promise<void> {
    return write(this.em.insert(OutboxMessageSchema, outboxMessageMapper.toRecord(message)));
  }

  save(message: OutboxMessage): Promise<void> {
    return updateOne(
      this.em.nativeUpdate(OutboxMessageSchema, { id: message.id }, outboxMessageMapper.toMutableRecord(message)),
      `outbox ${message.id}`,
    );
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxMessageSchema, { id }, FRESH);
    return record ? outboxMessageMapper.toDomain(record) : undefined;
  }

  // O lock de linha é o "lease": se o processo morrer, o Postgres desfaz a transação e libera as
  // linhas. Novas (next_attempt_at nulo) antes das em retry, para uma envenenada não segurar a fila.
  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      {
        ...FRESH,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { nextAttemptAt: QueryOrder.ASC_NULLS_FIRST, occurredAt: QueryOrder.ASC, id: QueryOrder.ASC },
        limit,
      },
    );
    return records.map(outboxMessageMapper.toDomain);
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const record = await this.em.findOne(
      OutboxMessageSchema,
      { publishedAt: null },
      { ...FRESH, fields: ['occurredAt'], orderBy: { occurredAt: QueryOrder.ASC } },
    );
    return record?.occurredAt;
  }
}
