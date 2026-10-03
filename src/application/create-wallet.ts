import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/integration-events';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { parseMoney, parseObject, parseText, type RequestContext } from './input';
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

export type CreateWalletResult = { outcome: 'created'; wallet: Wallet } | { outcome: 'conflict' };

export class CreateWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Lança InvalidPayloadError para entrada malformada. */
  async execute(input: unknown, ctx: RequestContext): Promise<CreateWalletResult> {
    const body = parseObject(input);
    const playerId = parseText(body.playerId, 'playerId');
    const initialBalance = parseMoney(body.initialBalance, 'initialBalance');

    const at = this.clock.now();
    const walletId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? WagerTransaction.opening({ id: this.ids.next(), walletId, playerId, money: initialBalance, createdAt: at })
      : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      at,
      opening: opening && { entryId: this.ids.next(), transactionId: opening.id },
    });
    opening?.markProcessed(undefined, wallet.balance, at);
    const eventCtx = () => ({ ...ctx, eventId: this.ids.next(), occurredAt: at });

    try {
      await this.runner.run(async () => {
        await this.wallets.add(wallet);
        if (!opening || !openingEntry) return;
        await this.transactions.add(opening);
        await this.ledger.append(openingEntry);
        await this.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventCtx())));
        await this.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventCtx())));
      });
    } catch (error) {
      // a unicidade (player + moeda) é do banco: é ela que decide a corrida entre criações concorrentes
      if (error instanceof UniqueViolationError && error.constraint === 'uq_wallets_player_currency') {
        return { outcome: 'conflict' };
      }
      throw error;
    }
    return { outcome: 'created', wallet };
  }
}
