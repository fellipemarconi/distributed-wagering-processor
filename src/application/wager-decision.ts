import { InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type IntegrationEvent,
} from '../domain/integration-events';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { validateReference } from '../domain/reference-validation';
import { WagerTransactionStatus as Status, type WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { RequestContext } from './input';
import type { IdGenerator, WagerTransactionRepository } from './ports';

/**
 * Regras de decisão de uma transação sobre a wallet já travada. Ponto único usado pela submissão
 * (ProcessWagerTransaction) e pelo reprocessamento de pendentes (ReprocessPendingReferences).
 */
export class WagerDecision {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly ids: IdGenerator,
  ) {}

  /** Leva `tx` ao estado decidido e devolve o lançamento, quando o saldo muda. */
  async decide(tx: WagerTransaction, wallet: Wallet, at: Date): Promise<WalletLedgerEntry | undefined> {
    const balance = wallet.balance;
    if (tx.playerId !== wallet.playerId) return void tx.reject(FailureCode.WalletPlayerMismatch, balance, at);
    if (tx.money.currency !== wallet.currency) return void tx.reject(FailureCode.CurrencyMismatch, balance, at);

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      reference = await this.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
      // Sem corrida: uma referência válida é da mesma wallet, que está travada. O índice único
      // uq_wager_tx_processed_reversal fica como rede de segurança.
      const alreadyReversed =
        reference !== undefined && tx.requiresReference() && (await this.transactions.hasProcessedReversalOf(reference.id));
      const check = validateReference(tx, reference, alreadyReversed);
      if (check.outcome === 'wait') return void tx.markPendingReference();
      if (check.outcome === 'reject') return void tx.reject(check.code, balance, at);
    }

    if (!tx.affectsBalance()) return void tx.markProcessed(reference?.id, balance, at);

    try {
      const movement = { entryId: this.ids.next(), transactionId: tx.id, at };
      const entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(tx.money, movement)
          : wallet.credit(tx.money, movement);
      tx.markProcessed(reference?.id, wallet.balance, at);
      return entry;
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      return void tx.reject(tx.insufficientFundsCode(), balance, at);
    }
  }

  events(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    ctx: RequestContext,
    at: Date,
  ): IntegrationEvent<unknown>[] {
    const eventCtx = () => ({ ...ctx, eventId: this.ids.next(), occurredAt: at });
    if (tx.status === Status.Rejected) return [WagerTransactionRejected.from(tx, eventCtx())];
    if (tx.status === Status.PendingReference) return [WagerTransactionPendingReference.from(tx, eventCtx())];
    const processed = WagerTransactionProcessed.from(tx, eventCtx());
    return entry ? [processed, WalletBalanceChanged.from(wallet, entry, eventCtx())] : [processed];
  }
}
