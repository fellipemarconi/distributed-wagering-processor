import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { brl, usd } from './fixtures';

describe('entrada', () => {
  test.each(['25.00', '25.5', '25', '0.00', '0', '99999999999999999.99'])('aceita %p', (amount) => {
    expect(() => brl(amount)).not.toThrow();
  });

  test.each([
    '10.001', '10.999', // mais de 2 casas: rejeita, não arredonda
    'NaN', 'Infinity', '-Infinity', '1e3', '1E-2', '', ' ', 'abc', '1,50', '.5', '5.', '+5.00', ' 5.00', '5.00 ',
    '-1.00', '-0.01', '-0.00', // negativos
    '0x10', '1_000', '5.00\n',
    '100000000000000000.00', // 18 dígitos inteiros: não cabe em NUMERIC(19,2)
  ])('rejeita %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([25, 25.5, null, undefined, NaN, {}, true])('rejeita valor que não é string: %p', (amount) => {
    expect(() => Money.from({ amount: amount as never, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'REAL', 'B1L', undefined, null])('rejeita moeda %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency: currency as never })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency as never)).toThrow(InvalidMoneyError);
  });

  test('rejeita props ausentes', () => {
    expect(() => Money.from(undefined as never)).toThrow(InvalidMoneyError);
  });
});

describe('serialização', () => {
  test.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.50', '25.50'],
    ['007.10', '7.10'],
  ])('%p serializa como %p', (input, output) => {
    expect(brl(input).toJSON()).toEqual({ amount: output, currency: 'BRL' });
  });

  test('zero', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(JSON.stringify({ m: brl('1') })).toBe('{"m":{"amount":"1.00","currency":"BRL"}}');
    expect(brl('1').toString()).toBe('1.00 BRL');
  });
});

describe('aritmética', () => {
  test('0.10 + 0.20 é exatamente 0.30', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('operandos são preservados e a instância é congelada', () => {
    const a = brl('100.00');
    const b = brl('80.00');
    expect(a.subtract(b).toJSON().amount).toBe('20.00');
    expect(a.toJSON().amount).toBe('100.00');
    expect(b.toJSON().amount).toBe('80.00');
    expect(() => ((a as { currency: string }).currency = 'USD')).toThrow(TypeError);
  });

  test('subtração e negação podem resultar em negativo', () => {
    const diff = brl('10.00').subtract(brl('25.00'));
    expect(diff.toJSON().amount).toBe('-15.00');
    expect(diff.isNegative()).toBe(true);
    expect(diff.isPositive()).toBe(false);
    expect(brl('5').negate().toJSON().amount).toBe('-5.00');
    expect(diff.negate().equals(brl('15'))).toBe(true);
  });

  test('exata no limite do NUMERIC(19,2)', () => {
    const max = brl('99999999999999999.99');
    expect(max.add(max).add(max).toJSON().amount).toBe('299999999999999999.97');
  });
});

describe('comparação', () => {
  test('zero, positivo, negativo', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0').isPositive()).toBe(false);
    expect(brl('0').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  test('igualdade independe da escala de entrada', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25').equals(brl('25.01'))).toBe(false);
  });

  test('mesmo montante em moedas diferentes não é igual', () => {
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });

  test('isLessThan', () => {
    expect(brl('9.99').isLessThan(brl('10'))).toBe(true);
    expect(brl('10').isLessThan(brl('10'))).toBe(false);
  });
});

describe('conflito de moeda', () => {
  test('soma, subtração e ordem entre moedas diferentes lançam CurrencyMismatchError', () => {
    expect(() => brl('10').add(usd('10'))).toThrow(CurrencyMismatchError);
    expect(() => brl('10').subtract(usd('10'))).toThrow(CurrencyMismatchError);
    expect(() => brl('10').isLessThan(usd('20'))).toThrow(CurrencyMismatchError);
  });
});
