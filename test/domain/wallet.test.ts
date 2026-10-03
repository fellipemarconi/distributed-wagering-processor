import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainError, InsufficientFundsError } from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Wallet } from '../../src/domain/wallet';
import { brl, ctx, T0, T1, usd, walletWith } from './fixtures';

describe('abertura', () => {
  test('com saldo inicial positivo: version 1 e lançamento CREDIT de 0 até o saldo', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      initialBalance: brl('1000.00'),
      at: T0,
      opening: { entryId: 'e1', transactionId: 'tx-open' },
    });
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toMatchObject({ walletId: 'w1', transactionId: 'tx-open', direction: LedgerDirection.Credit });
    expect(openingEntry!.money.equals(brl('1000'))).toBe(true);
    expect(openingEntry!.balanceBefore.isZero()).toBe(true);
    expect(openingEntry!.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('com saldo zero: sem lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('0.00'), at: T0 });
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('saldo inicial negativo ou positivo sem transação de abertura falha', () => {
    const negative = brl('0').subtract(brl('1'));
    expect(() => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: negative, at: T0 })).toThrow(DomainError);
    expect(() => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('1'), at: T0 })).toThrow(DomainError);
  });
});

describe('débito e crédito', () => {
  test('débito devolve o lançamento correspondente', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.debit(brl('80.00'), { entryId: 'e1', transactionId: 'tx1', at: T1 });
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(entry).toMatchObject({
      id: 'e1',
      walletId: 'w1',
      transactionId: 'tx1',
      direction: LedgerDirection.Debit,
      createdAt: T1,
    });
    expect(entry.money.equals(brl('80.00'))).toBe(true);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('crédito devolve o lançamento correspondente', () => {
    const wallet = walletWith('20.00');
    const entry = wallet.credit(brl('50.00'), ctx());
    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.equals(brl('20.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('70.00'))).toBe(true);
  });

  test('débito do saldo inteiro leva a zero', () => {
    const wallet = walletWith('100.00');
    wallet.debit(brl('100.00'), ctx());
    expect(wallet.balance.isZero()).toBe(true);
  });
});

describe('invariantes', () => {
  test('débito acima do saldo falha sem efeito colateral', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.debit(brl('100.01'), ctx())).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(T0);
  });

  test('duas apostas de 80 sobre 100: uma aplica, a outra falha, saldo 20, um lançamento', () => {
    const wallet = walletWith('100.00');
    const entries = [];
    entries.push(wallet.debit(brl('80.00'), ctx('bet-1')));
    expect(() => entries.push(wallet.debit(brl('80.00'), ctx('bet-2')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(entries).toHaveLength(1);
  });

  test('conflito de moeda não altera a wallet', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.debit(usd('10.00'), ctx())).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd('10.00'), ctx())).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('valor zero ou negativo é rejeitado', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.credit(brl('0.00'), ctx())).toThrow(DomainError);
    expect(() => wallet.debit(brl('0.00'), ctx())).toThrow(DomainError);
    expect(() => wallet.debit(brl('10').negate(), ctx())).toThrow(DomainError);
    expect(wallet.version).toBe(1);
  });

  test('version incrementa em 1 por movimentação aplicada e updatedAt acompanha', () => {
    const { wallet } = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('0'), at: T0 });
    wallet.credit(brl('10'), ctx());
    wallet.debit(brl('5'), ctx());
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toBe(T1);
    expect(wallet.createdAt).toBe(T0);
  });

  test('saldo sempre igual ao reconstruído pelos lançamentos', () => {
    const wallet = walletWith('0.00');
    const entries = [
      wallet.credit(brl('100'), ctx()),
      wallet.debit(brl('33.33'), ctx()),
      wallet.credit(brl('0.01'), ctx()),
      wallet.debit(brl('66.68'), ctx()),
    ];
    const rebuilt = entries.reduce(
      (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
      brl('0'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
  });
});

test('reidratação preserva o estado e não gera lançamento', () => {
  const wallet = Wallet.rehydrate({
    id: 'w1',
    playerId: 'p1',
    balance: brl('975.00'),
    version: 7,
    createdAt: T0,
    updatedAt: T0,
  });
  expect(wallet.balance.equals(brl('975.00'))).toBe(true);
  expect(wallet.version).toBe(7);
  wallet.debit(brl('1'), ctx());
  expect(wallet.version).toBe(8);
});
