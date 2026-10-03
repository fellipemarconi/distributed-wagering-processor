import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { parseUuid } from '../application/input';
import { WagerTransactionRepository } from '../application/ports';
import { ProcessWagerTransaction, type ProcessWagerResult } from '../application/process-wager-transaction';
import { WagerTransactionStatus as Status, type WagerTransaction } from '../domain/wager-transaction';
import { currentCorrelationId } from '../observability/correlation.middleware';
import { setLogContext } from '../observability/log-context';
import { Metrics } from '../observability/metrics';
import { apiError } from './api-error';
import { AuthGuard } from './auth.guard';

type Persisted = Extract<ProcessWagerResult, { transaction: WagerTransaction }>;

/**
 * Mapeamento único desfecho → status (ARCHITECTURE.md). O replay responde pelo estado gravado:
 * 200 aplicada, 422 rejeitada, 202 pendente.
 */
function statusOf(result: Persisted): number {
  if (result.transaction.status === Status.Rejected) return 422;
  if (result.transaction.status === Status.PendingReference) return 202;
  return result.outcome === 'replay' ? 200 : 201;
}

/** `balance` é o saldo observado na decisão — ausente enquanto pendente. */
const outcomeBody = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  status: tx.status,
  ...(tx.failureCode !== undefined && { failureCode: tx.failureCode }),
  ...(tx.resultBalance !== undefined && { balance: tx.resultBalance.toJSON() }),
});

const transactionBody = (tx: WagerTransaction) => ({
  ...outcomeBody(tx),
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  ...(tx.referenceExternalTransactionId !== undefined && {
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
  }),
  createdAt: tx.createdAt.toISOString(),
  ...(tx.completedAt !== undefined && { completedAt: tx.completedAt.toISOString() }),
});

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly transactions: WagerTransactionRepository,
    private readonly metrics: Metrics,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw apiError(400, 'MISSING_IDEMPOTENCY_KEY', 'O header Idempotency-Key é obrigatório');
    }
    const stopTimer = this.metrics.processingDuration.startTimer({ channel: 'http' });
    // o header é a fonte da verdade da chave; um idempotencyKey no corpo é sobrescrito
    const result = await this.processWager
      .execute({ ...(body as object), idempotencyKey }, { correlationId: currentCorrelationId() })
      .finally(stopTimer);
    if ('transaction' in result) {
      const { id, walletId, providerId } = result.transaction;
      setLogContext({ transactionId: id, walletId, providerId });
      this.metrics.recordWager('http', result.outcome, result.transaction);
    }
    if (result.outcome === 'not-found') throw apiError(404, 'WALLET_NOT_FOUND', 'Wallet não encontrada');
    if (result.outcome === 'conflict') {
      throw apiError(
        409,
        result.code,
        result.code === 'IDEMPOTENCY_KEY_CONFLICT'
          ? 'Idempotency-Key já usada com outro payload'
          : 'externalTransactionId já registrado com outra Idempotency-Key',
      );
    }
    response.status(statusOf(result));
    return { ...outcomeBody(result.transaction), idempotentReplay: result.outcome === 'replay' };
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return this.found(await this.transactions.findById(parseUuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.found(await this.transactions.findByExternalId(providerId, externalTransactionId));
  }

  private found(tx: WagerTransaction | undefined) {
    if (!tx) throw apiError(404, 'TRANSACTION_NOT_FOUND', 'Transação não encontrada');
    setLogContext({ transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId });
    return transactionBody(tx);
  }
}
