import { CurrencyMismatchError, DomainError, InsufficientFundsError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Ids e instante vêm de fora: o domínio não gera ids nem lê o relógio. */
export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Nasce já com o saldo inicial e version 1 (contrato da API). Por isso não reutiliza credit(),
   * que levaria a version a 2; o lançamento de abertura (0 → inicial) é devolvido junto.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
    opening?: { entryId: string; transactionId: string };
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { id, playerId, initialBalance, at, opening } = props;
    if (initialBalance.isNegative()) throw new DomainError('Saldo inicial não pode ser negativo');
    const wallet = new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) return { wallet };
    if (!opening) throw new DomainError('Saldo inicial positivo exige a transação de abertura');
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida nada. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.balance.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, money, ctx);
  }

  // Único caminho que muda o saldo, e ele devolve o lançamento: saldo e ledger não divergem.
  private apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new DomainError('Movimentação exige valor positivo');
    const balanceAfter =
      direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(`Saldo insuficiente: ${this._balance} para debitar ${money}`);
    }
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: ctx.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet em ${this.currency} não aceita ${money.currency}`);
    }
  }
}
