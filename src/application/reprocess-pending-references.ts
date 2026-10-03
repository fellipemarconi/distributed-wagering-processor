import { FailureCode } from '../domain/failure-code';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransactionStatus as Status, type WagerTransactionKind } from '../domain/wager-transaction';
import {
  Clock,
  IdGenerator,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  WagerTransactionRepository,
  WalletRepository,
} from './ports';
import { WagerDecision } from './wager-decision';

type Outcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped' | 'failed';

/** Sem valores monetários: é o que o worker loga. */
export interface CandidateOutcome {
  transactionId: string;
  walletId: string;
  /** Ausentes quando a transação não chegou a ser carregada (skipped, failed). */
  providerId?: string;
  kind?: WagerTransactionKind;
  outcome: Outcome;
  durationMs?: number;
  failureCode?: FailureCode;
  /** Tentativas sem a referência, contando esta. */
  attempts?: number;
  error?: string;
}

export type ReprocessPendingReferencesResult = Record<Outcome, number> & {
  selected: number;
  outcomes: CandidateOutcome[];
};

/**
 * Um lote de PENDING_REFERENCE vencidas. Cada candidata roda na própria transação, com a mesma
 * ordem de lock da submissão (wallet, depois transação) e as mesmas regras (WagerDecision).
 * Fluxo, TTL e ausência de deadlock: ARCHITECTURE.md.
 */
export class ReprocessPendingReferences {
  private readonly decision: WagerDecision;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    ids: IdGenerator,
    private readonly clock: Clock,
    private readonly batchSize: number,
    private readonly ttlMs: number,
  ) {
    this.decision = new WagerDecision(transactions, ids);
  }

  /** `stopping`: consultado antes de cada candidata, para o encerramento não esperar o lote inteiro. */
  // ponytail: candidatas em série, e dois workers podem selecionar o mesmo lote (o segundo espera a
  // wallet e ignora). Paralelizar por wallet se o volume de pendentes crescer.
  async execute(stopping: () => boolean = () => false): Promise<ReprocessPendingReferencesResult> {
    const candidates = await this.transactions.findDuePendingReferences(this.clock.now(), this.batchSize);
    const result: ReprocessPendingReferencesResult = {
      selected: candidates.length,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
    };
    for (const candidate of candidates) {
      if (stopping()) break;
      let outcome: CandidateOutcome;
      const startedAt = performance.now();
      try {
        outcome = await this.reprocess(candidate.id, candidate.walletId);
      } catch (error) {
        // lock_timeout, conexão…: só esta candidata é desfeita; continua vencida para a próxima rodada
        outcome = {
          transactionId: candidate.id,
          walletId: candidate.walletId,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      outcome.durationMs = performance.now() - startedAt;
      result[outcome.outcome] += 1;
      result.outcomes.push(outcome);
    }
    return result;
  }

  private reprocess(id: string, walletId: string): Promise<CandidateOutcome> {
    return this.runner.run<CandidateOutcome>(async () => {
      const wallet = await this.wallets.findByIdForUpdate(walletId);
      // instante lido depois do lock: quem esperou outro worker vê o reagendamento dele como futuro
      const at = this.clock.now();
      const tx = wallet && (await this.transactions.claimPendingReference(id, at));
      if (!wallet || !tx) return { transactionId: id, walletId, outcome: 'skipped' };
      const ids = { transactionId: id, walletId, providerId: tx.providerId, kind: tx.kind };

      const entry = await this.decision.decide(tx, wallet, at);
      if (tx.status === Status.PendingReference) {
        const deadline = new Date(tx.createdAt.getTime() + this.ttlMs);
        if (at >= deadline) tx.reject(FailureCode.ReferenceNotFound, wallet.balance, at);
        else tx.scheduleReferenceRetry(at, deadline);
      }

      await this.transactions.savePendingReference(tx);
      if (entry) {
        await this.ledger.append(entry);
        await this.wallets.save(wallet);
      }
      if (!tx.isTerminal()) return { ...ids, outcome: 'rescheduled', attempts: tx.referenceAttempts };

      // o correlationId da submissão original não é persistido: o id da transação liga estes
      // eventos ao WagerTransactionPendingReference dela
      for (const event of this.decision.events(tx, wallet, entry, { correlationId: tx.id }, at)) {
        await this.outbox.add(OutboxMessage.enqueue(event));
      }
      // cadeias (ROLLBACK → REFUND → BET): quem aguardava esta transação é reavaliado já
      await this.transactions.wakePendingReferencesOf(tx.providerId, tx.externalTransactionId, at);
      return tx.status === Status.Rejected
        ? { ...ids, outcome: 'rejected', failureCode: tx.failureCode, attempts: tx.referenceAttempts }
        : { ...ids, outcome: 'processed', attempts: tx.referenceAttempts };
    });
  }
}
