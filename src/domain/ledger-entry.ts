import { DomainError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Imutável por construção: só campos readonly, instância congelada, nenhum método de transição. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) throw new DomainError('Lançamento exige valor positivo');
    // isBalanced lança CurrencyMismatchError se as moedas divergirem.
    if (!entry.isBalanced()) throw new DomainError('Lançamento desbalanceado: balanceBefore ± money ≠ balanceAfter');
    if (entry.balanceAfter.isNegative()) throw new DomainError('Lançamento resultaria em saldo negativo');
    return entry;
  }

  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id,
      s.walletId,
      s.transactionId,
      s.direction,
      s.money,
      s.balanceBefore,
      s.balanceAfter,
      s.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    // subtract (e não equals): moeda divergente lança erro de conflito em vez de devolver `false`.
    return expected.subtract(this.balanceAfter).isZero();
  }
}
