import { Decimal as BaseDecimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

// O default do decimal.js (20 dígitos significativos) arredondaria somas de valores no limite
// do NUMERIC(19,2); 40 dá folga para a aritmética continuar exata.
const Decimal = BaseDecimal.clone({ precision: 40 });
type Decimal = BaseDecimal;

// A regex roda antes do Decimal: elimina NaN, Infinity, notação científica, sinal, espaços e
// mais de 2 casas sem nunca arredondar. 17 dígitos inteiros = limite do NUMERIC(19,2).
const AMOUNT = /^\d{1,17}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Rejeita negativos: eles só existem como resultado de subtract/negate. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? {};
    if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
      throw new InvalidMoneyError(`Valor monetário inválido: ${JSON.stringify(amount)}`);
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`Moeda inválida: ${JSON.stringify(currency)}`);
    }
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}
