import { DomainError, InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type IntegrationEvent,
} from '../domain/integration-events';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/outbox-message';
import { computePayloadHash } from '../domain/payload-hash';
import { validateReference } from '../domain/reference-validation';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { InvalidPayloadError, parseMoney, parseObject, parseText, parseUuid, type RequestContext } from './input';
import {
  Clock,
  IdGenerator,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  UniqueViolationError,
  WagerTransactionRepository,
  WalletRepository,
} from './ports';

export type IdempotencyConflictCode = 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_CONFLICT';

/** Resultado sem noção de transporte: HTTP e fila traduzem cada um do seu jeito. */
export type ProcessWagerResult =
  | { outcome: 'processed' | 'rejected' | 'pending' | 'replay'; transaction: WagerTransaction }
  | { outcome: 'conflict'; code: IdempotencyConflictCode }
  | { outcome: 'not-found' };

const EXTERNAL_KINDS: string[] = Object.values(Kind).filter((kind) => kind !== Kind.Opening);
const IDEMPOTENCY_CONSTRAINTS = ['uq_wager_tx_provider_idempotency_key', 'uq_wager_tx_provider_external'];

export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * `input`: campos de negócio + `idempotencyKey` (no HTTP vem do header; na fila, do corpo da mensagem).
   * Lança InvalidPayloadError para entrada malformada. Fluxo completo: ARCHITECTURE.md.
   */
  async execute(input: unknown, ctx: RequestContext): Promise<ProcessWagerResult> {
    const at = this.clock.now();
    const tx = this.parse(input, at); // 1. validação e hash fora da transação

    try {
      return await this.runner.run<ProcessWagerResult>(async () => {
        // 2. o lock da wallet serializa tudo que toca o mesmo saldo — inclusive duplicatas da mesma requisição
        const wallet = await this.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) return { outcome: 'not-found' };

        const prior = await this.findPrior(tx); // 3.
        if (prior) return prior;

        const entry = await this.decide(tx, wallet, at); // 4.

        // 5. transação já no estado final: um INSERT, nenhum UPDATE. Ordem imposta pelas FKs.
        await this.transactions.add(tx);
        if (entry) {
          await this.ledger.append(entry);
          await this.wallets.save(wallet);
        }
        for (const event of this.events(tx, wallet, entry, ctx, at)) {
          await this.outbox.add(OutboxMessage.enqueue(event));
        }
        const outcome =
          tx.status === Status.Rejected ? 'rejected' : tx.status === Status.PendingReference ? 'pending' : 'processed';
        return { outcome, transaction: tx };
      });
    } catch (error) {
      // 6. corrida fora do lock (mesma chave ou id externo com wallets diferentes): o banco recusou e
      // abortou a transação, então a releitura é em transação nova.
      if (error instanceof UniqueViolationError && IDEMPOTENCY_CONSTRAINTS.includes(error.constraint)) {
        const prior = await this.runner.run(() => this.findPrior(tx));
        if (prior) return prior;
      }
      throw error;
    }
  }

  private parse(input: unknown, at: Date): WagerTransaction {
    const body = parseObject(input);
    const kind = parseText(body.kind, 'kind');
    if (!EXTERNAL_KINDS.includes(kind)) {
      throw new InvalidPayloadError(`kind deve ser um de ${EXTERNAL_KINDS.join(', ')}`);
    }
    const reference = body.referenceExternalTransactionId;
    const business = {
      providerId: parseText(body.providerId, 'providerId'),
      externalTransactionId: parseText(body.externalTransactionId, 'externalTransactionId'),
      playerId: parseText(body.playerId, 'playerId'),
      walletId: parseUuid(body.walletId, 'walletId'),
      roundId: parseText(body.roundId, 'roundId'),
      gameId: parseText(body.gameId, 'gameId'),
      kind: kind as Kind,
      money: parseMoney(body.money, 'money'),
      referenceExternalTransactionId:
        reference === undefined || reference === null
          ? undefined
          : parseText(reference, 'referenceExternalTransactionId'),
    };
    try {
      // create é o validador das regras por tipo; a instância só é gravada no passo 5
      return WagerTransaction.create({
        ...business,
        id: this.ids.next(),
        idempotencyKey: parseText(body.idempotencyKey, 'idempotencyKey'),
        payloadHash: computePayloadHash({ ...business, money: business.money.toJSON() }),
        createdAt: at,
      });
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidPayloadError(error.message);
      throw error;
    }
  }

  private async findPrior(tx: WagerTransaction): Promise<ProcessWagerResult | undefined> {
    const sameKey = await this.transactions.findByIdempotencyKey(tx.providerId, tx.idempotencyKey);
    if (sameKey) {
      return sameKey.matchesPayload(tx.payloadHash)
        ? { outcome: 'replay', transaction: sameKey }
        : { outcome: 'conflict', code: 'IDEMPOTENCY_KEY_CONFLICT' };
    }
    if (await this.transactions.findByExternalId(tx.providerId, tx.externalTransactionId)) {
      return { outcome: 'conflict', code: 'EXTERNAL_TRANSACTION_CONFLICT' };
    }
    return undefined;
  }

  /** Leva `tx` ao estado decidido e devolve o lançamento, quando o saldo muda. */
  private async decide(tx: WagerTransaction, wallet: Wallet, at: Date): Promise<WalletLedgerEntry | undefined> {
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

  private events(
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
