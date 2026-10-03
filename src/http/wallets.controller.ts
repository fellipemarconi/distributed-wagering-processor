import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateWallet } from '../application/create-wallet';
import { InvalidPayloadError, parseUuid } from '../application/input';
import { LedgerRepository, WalletRepository } from '../application/ports';
import { ReconcileWallet } from '../application/reconcile-wallet';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Wallet } from '../domain/wallet';
import { currentCorrelationId } from '../observability/correlation.middleware';
import { setLogContext } from '../observability/log-context';
import { Metrics } from '../observability/metrics';
import { apiError } from './api-error';
import { AuthGuard } from './auth.guard';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const walletBody = (w: Wallet) => ({ id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version });

const entryBody = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

// Cursor opaco: base64url do seq do último lançamento devolvido.
const encodeCursor = (seq: string) => Buffer.from(seq).toString('base64url');
function decodeCursor(cursor: string): string {
  const seq = Buffer.from(cursor, 'base64url').toString();
  if (!/^\d{1,19}$/.test(seq)) throw new InvalidPayloadError('cursor inválido');
  return seq;
}

function parseLimit(limit: string | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9]\d{0,8}$/.test(limit)) throw new InvalidPayloadError('limit deve ser um inteiro maior que zero');
  return Math.min(Number(limit), MAX_LIMIT);
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly createWallet: CreateWallet,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly metrics: Metrics,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const result = await this.createWallet.execute(body, { correlationId: currentCorrelationId() });
    if (result.outcome === 'conflict') {
      throw apiError(409, 'WALLET_ALREADY_EXISTS', 'Já existe wallet para este jogador nesta moeda');
    }
    setLogContext({ walletId: result.wallet.id });
    // saldo inicial positivo = transação OPENING aplicada
    if (result.wallet.balance.isPositive()) {
      this.metrics.transactions.inc({ kind: 'OPENING', status: 'PROCESSED', channel: 'http' });
    }
    return walletBody(result.wallet);
  }

  /** Só lê e relata: divergência vira log de erro, métrica e consistent: false — nunca correção. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const id = parseUuid(walletId, 'walletId');
    setLogContext({ walletId: id });
    const result = await this.reconcileWallet.execute(id);
    if (result.outcome === 'not-found') throw apiError(404, 'WALLET_NOT_FOUND', 'Wallet não encontrada');

    const { storedBalance, calculatedBalance, difference, consistent, chainIntact, checkedEntries } = result;
    if (!consistent) {
      this.metrics.reconciliationDivergences.inc();
      // sem valores monetários no log: saldos e diferença estão na resposta
      this.logger.error({
        message: 'Reconciliação divergente: saldo armazenado não corresponde ao ledger',
        walletId: id,
        balanceMatches: difference.isZero(),
        chainIntact,
        checkedEntries,
        firstBrokenEntryId: result.firstBrokenEntryId,
      });
    }
    return {
      walletId: id,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      chainIntact,
      checkedEntries,
    };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletBody(await this.find(walletId));
  }

  @Get(':walletId/ledger')
  async listLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const page = { after: cursor === undefined ? undefined : decodeCursor(cursor), limit: parseLimit(limit) };
    const wallet = await this.find(walletId);
    const { entries, nextCursor } = await this.ledger.listByWallet(wallet.id, page);
    return { entries: entries.map(entryBody), ...(nextCursor !== undefined && { nextCursor: encodeCursor(nextCursor) }) };
  }

  // Leitura de uma linha direto no repositório: um use case aqui seria só repasse.
  private async find(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(parseUuid(walletId, 'walletId'));
    setLogContext({ walletId });
    if (!wallet) throw apiError(404, 'WALLET_NOT_FOUND', 'Wallet não encontrada');
    return wallet;
  }
}
