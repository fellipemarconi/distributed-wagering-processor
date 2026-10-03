import { expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry, type CreateLedgerEntryProps } from '../../src/domain/ledger-entry';
import { brl, T0, usd } from './fixtures';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 'tx1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: T0,
  ...overrides,
});

test('lançamento consistente é criado e está balanceado', () => {
  expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
  const credit = props({ direction: LedgerDirection.Credit, balanceBefore: brl('20'), balanceAfter: brl('100') });
  expect(WalletLedgerEntry.create(credit).isBalanced()).toBe(true);
});

test.each([
  ['aritmética incorreta', { balanceAfter: brl('30.00') }],
  ['direção trocada', { direction: LedgerDirection.Credit }],
  ['valor zero', { money: brl('0'), balanceAfter: brl('100.00') }],
  ['valor negativo', { money: brl('0').subtract(brl('80')), balanceAfter: brl('180.00') }],
  ['saldo posterior negativo', { money: brl('120'), balanceAfter: brl('100').subtract(brl('120')) }],
] as const)('rejeita %s', (_name, overrides) => {
  expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(DomainError);
});

test.each([
  ['money', { money: usd('80.00') }],
  ['balanceBefore', { balanceBefore: usd('100.00') }],
  ['balanceAfter', { balanceAfter: usd('20.00') }],
] as const)('rejeita moeda divergente em %s', (_name, overrides) => {
  expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(CurrencyMismatchError);
});

test('rehydrate não valida', () => {
  const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('30.00') }));
  expect(entry.isBalanced()).toBe(false);
});

test('é imutável: atribuir a qualquer campo lança', () => {
  const entry = WalletLedgerEntry.create(props());
  for (const field of Object.keys(entry)) {
    expect(() => ((entry as unknown as Record<string, unknown>)[field] = 'x')).toThrow(TypeError);
  }
  expect(Object.keys(entry).sort()).toEqual(
    ['balanceAfter', 'balanceBefore', 'createdAt', 'direction', 'id', 'money', 'transactionId', 'walletId'],
  );
  expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
});
