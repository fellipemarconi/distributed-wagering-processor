// Regras de BET, WIN, LOSS, REFUND e ROLLBACK (CHALLENGE §7) compondo transação + wallet,
// como o use case fará: a direção vem da transação, o saldo e o lançamento vêm da wallet.
import { expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { brl, ctx, stored, T1, tx, usd, walletWith } from './fixtures';

function apply(wallet: Wallet, t: WagerTransaction, reference?: WagerTransaction): WalletLedgerEntry | undefined {
  if (!t.affectsBalance()) return undefined;
  return t.ledgerDirectionFor(reference) === LedgerDirection.Debit
    ? wallet.debit(t.money, ctx(t.id))
    : wallet.credit(t.money, ctx(t.id));
}

test('BET debita e WIN credita, um lançamento cada', () => {
  const wallet = walletWith('100.00');
  const debit = apply(wallet, tx({ money: brl('25.00') }));
  const credit = apply(wallet, tx({ kind: Kind.Win, money: brl('60.00') }));
  expect(wallet.balance.equals(brl('135.00'))).toBe(true);
  expect(debit!.direction).toBe(LedgerDirection.Debit);
  expect(credit!.direction).toBe(LedgerDirection.Credit);
});

test('BET sem saldo: débito falha e o código é INSUFFICIENT_FUNDS', () => {
  const wallet = walletWith('10.00');
  const bet = tx({ money: brl('25.00') });
  expect(() => apply(wallet, bet)).toThrow(InsufficientFundsError);
  bet.reject(bet.insufficientFundsCode(), wallet.balance, T1);
  expect(bet.resultBalance!.equals(brl('10.00'))).toBe(true);
  expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(wallet.balance.equals(brl('10.00'))).toBe(true);
});

test('LOSS não move saldo nem gera lançamento', () => {
  const wallet = walletWith('100.00');
  expect(apply(wallet, tx({ kind: Kind.Loss }))).toBeUndefined();
  expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  expect(wallet.version).toBe(1);
});

test('REFUND devolve a aposta', () => {
  const wallet = walletWith('100.00');
  const bet = tx({ money: brl('25.00') });
  apply(wallet, bet);
  const entry = apply(wallet, tx({ kind: Kind.Refund, money: brl('25.00') }), bet);
  expect(entry!.direction).toBe(LedgerDirection.Credit);
  expect(wallet.balance.equals(brl('100.00'))).toBe(true);
});

test('ROLLBACK de BET credita; ROLLBACK de WIN e de REFUND debitam', () => {
  const wallet = walletWith('100.00');
  const rollback = tx({ kind: Kind.Rollback, money: brl('25.00') });
  expect(apply(wallet, rollback, stored({ kind: Kind.Bet }))!.direction).toBe(LedgerDirection.Credit);
  expect(wallet.balance.equals(brl('125.00'))).toBe(true);
  expect(apply(wallet, rollback, stored({ kind: Kind.Win }))!.direction).toBe(LedgerDirection.Debit);
  expect(apply(wallet, rollback, stored({ kind: Kind.Refund }))!.direction).toBe(LedgerDirection.Debit);
  expect(wallet.balance.equals(brl('75.00'))).toBe(true);
});

test('ROLLBACK de WIN com saldo já gasto: rejeitado com REVERSAL_INSUFFICIENT_FUNDS, sem lançamento', () => {
  const wallet = walletWith('10.00');
  const win = stored({ kind: Kind.Win, money: brl('60.00') });
  const rollback = tx({ kind: Kind.Rollback, money: brl('60.00') });
  expect(() => apply(wallet, rollback, win)).toThrow(InsufficientFundsError);
  rollback.reject(rollback.insufficientFundsCode(), wallet.balance, T1);
  expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  expect(wallet.balance.equals(brl('10.00'))).toBe(true);
  expect(wallet.version).toBe(1);
});

test('conflito de moeda: transação em USD sobre wallet em BRL', () => {
  const wallet = walletWith('100.00');
  expect(() => apply(wallet, tx({ money: usd('25.00') }))).toThrow(CurrencyMismatchError);
  expect(() => apply(wallet, tx({ kind: Kind.Win, money: usd('25.00') }))).toThrow(CurrencyMismatchError);
  expect(wallet.balance.equals(brl('100.00'))).toBe(true);
});
