import { describe, expect, test } from 'bun:test';
import { DomainError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { brl, stored, T0, T1, tx } from './fixtures';

describe('criação', () => {
  test('BET nasce em PENDING, sem failureCode nem processedAt', () => {
    const bet = tx();
    expect(bet.status).toBe(Status.Pending);
    expect(bet.failureCode).toBeUndefined();
    expect(bet.processedAt).toBeUndefined();
    expect(bet.referenceTransactionId).toBeUndefined();
    expect(bet.resultBalance).toBeUndefined();
    expect(bet.completedAt).toBeUndefined();
    expect(bet.isTerminal()).toBe(false);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s sem referência falha', (kind) => {
    expect(() => tx({ kind, referenceExternalTransactionId: undefined })).toThrow(DomainError);
  });

  test('BET com referência falha; WIN e LOSS aceitam referência opcional', () => {
    expect(() => tx({ referenceExternalTransactionId: 'ext-x' })).toThrow(DomainError);
    expect(() => tx({ kind: Kind.Win, referenceExternalTransactionId: 'ext-BET' })).not.toThrow();
    expect(() => tx({ kind: Kind.Win })).not.toThrow();
    expect(() => tx({ kind: Kind.Loss, referenceExternalTransactionId: 'ext-BET' })).not.toThrow();
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('%s com valor zero falha', (kind) => {
    expect(() => tx({ kind, money: brl('0.00') })).toThrow(DomainError);
  });

  test('LOSS aceita valor zero; nenhum kind aceita negativo', () => {
    expect(() => tx({ kind: Kind.Loss, money: brl('0.00') })).not.toThrow();
    expect(() => tx({ kind: Kind.Loss, money: brl('1').negate() })).toThrow(DomainError);
  });

  test('OPENING não entra como transação externa', () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(DomainError);
  });

  test('providerId reservado às transações internas não é aceito em create', () => {
    expect(() => tx({ providerId: INTERNAL_PROVIDER_ID })).toThrow(DomainError);
    const opening = WagerTransaction.opening({ id: 'o', walletId: 'w1', playerId: 'p1', money: brl('1'), createdAt: T0 });
    expect(opening.providerId).toBe(INTERNAL_PROVIDER_ID);
  });

  test('OPENING pelo caminho interno', () => {
    const opening = WagerTransaction.opening({
      id: 'tx-open',
      walletId: 'w1',
      playerId: 'p1',
      money: brl('1000.00'),
      createdAt: T0,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Pending);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(opening.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      WagerTransaction.opening({ id: 'x', walletId: 'w1', playerId: 'p1', money: brl('0'), createdAt: T0 }),
    ).toThrow(DomainError);
  });
});

describe('máquina de estados', () => {
  test('PENDING → PROCESSED grava processedAt', () => {
    const bet = tx();
    bet.markProcessed(undefined, brl('75.00'), T1);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.processedAt).toBe(T1);
    expect(bet.completedAt).toBe(T1);
    expect(bet.resultBalance!.equals(brl('75.00'))).toBe(true);
    expect(bet.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED grava o failureCode', () => {
    const bet = tx();
    bet.reject(FailureCode.InsufficientFunds, brl('10.00'), T1);
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.processedAt).toBeUndefined();
    expect(bet.completedAt).toBe(T1);
    expect(bet.resultBalance!.equals(brl('10.00'))).toBe(true);
  });

  test('PENDING → FAILED grava o failureCode', () => {
    const bet = tx();
    bet.fail(FailureCode.InternalError, T1);
    expect(bet.status).toBe(Status.Failed);
    expect(bet.failureCode).toBe(FailureCode.InternalError);
    expect(bet.processedAt).toBeUndefined();
    expect(bet.completedAt).toBe(T1);
    expect(bet.resultBalance).toBeUndefined();
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED guarda a referência resolvida', () => {
    const refund = tx({ kind: Kind.Refund });
    refund.markPendingReference();
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.isTerminal()).toBe(false);
    refund.markPendingReference(); // nova tentativa ainda sem referência: no-op
    expect(refund.status).toBe(Status.PendingReference);
    refund.markProcessed('tx-BET', brl('100.00'), T1);
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe('tx-BET');
  });

  test('PENDING_REFERENCE → REJECTED e → FAILED', () => {
    const refund = tx({ kind: Kind.Refund });
    refund.markPendingReference();
    refund.reject(FailureCode.ReferenceNotFound, brl('75.00'), T1);
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);

    const rollback = tx({ kind: Kind.Rollback });
    rollback.markPendingReference();
    rollback.fail(FailureCode.InternalError, T1);
    expect(rollback.status).toBe(Status.Failed);
  });

  const transitions: Array<[string, (t: WagerTransaction) => void]> = [
    ['markProcessed', (t) => t.markProcessed('tx-BET', brl('1.00'), T1)],
    ['markPendingReference', (t) => t.markPendingReference()],
    ['reject', (t) => t.reject(FailureCode.ReferenceMismatch, brl('1.00'), T1)],
    ['fail', (t) => t.fail(FailureCode.InternalError, T1)],
  ];
  const terminals = [
    { status: Status.Processed, processedAt: T0, completedAt: T0, resultBalance: brl('75.00'), referenceTransactionId: 'tx-BET' },
    { status: Status.Rejected, processedAt: undefined, completedAt: T0, resultBalance: brl('10.00'), failureCode: FailureCode.InsufficientFunds },
    { status: Status.Failed, processedAt: undefined, completedAt: T0, failureCode: FailureCode.InternalError },
  ];
  for (const terminal of terminals) {
    test.each(transitions)(`${terminal.status}: %s lança InvalidTransactionStateError sem alterar nada`, (_n, go) => {
      const t = stored({ kind: Kind.Refund, ...terminal });
      expect(() => go(t)).toThrow(InvalidTransactionStateError);
      expect(t.status).toBe(terminal.status);
      expect(t.failureCode).toBe(terminal.failureCode);
      expect(t.processedAt).toBe(terminal.processedAt);
      expect(t.referenceTransactionId).toBe(terminal.referenceTransactionId);
      expect(t.completedAt).toBe(T0);
      expect(t.resultBalance).toBe(terminal.resultBalance);
    });
  }

  test('BET não pode aguardar referência', () => {
    const bet = tx();
    expect(() => bet.markPendingReference()).toThrow(DomainError);
    expect(bet.status).toBe(Status.Pending);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s não é processado sem a referência resolvida', (kind) => {
    const t = tx({ kind });
    expect(() => t.markProcessed(undefined, brl('1.00'), T1)).toThrow(DomainError);
    expect(t.completedAt).toBeUndefined();
    expect(t.resultBalance).toBeUndefined();
    expect(t.status).toBe(Status.Pending);
    expect(t.processedAt).toBeUndefined();
  });
});

test('rehydrate reconstrói qualquer estado e kind sem validar', () => {
  const rejected = stored({ status: Status.Rejected, failureCode: FailureCode.ReferenceMismatch, processedAt: undefined });
  expect(rejected.status).toBe(Status.Rejected);
  expect(rejected.failureCode).toBe(FailureCode.ReferenceMismatch);
  expect(rejected.isTerminal()).toBe(true);
  const replayed = stored({ resultBalance: brl('975.00'), completedAt: T1 });
  expect(replayed.resultBalance!.toJSON()).toEqual({ amount: '975.00', currency: 'BRL' });
  expect(replayed.completedAt).toBe(T1);
  expect(stored({ kind: Kind.Opening }).kind).toBe(Kind.Opening);
  expect(() => stored({ kind: Kind.Refund, referenceExternalTransactionId: undefined })).not.toThrow();
});

describe('consultas', () => {
  test.each([
    [Kind.Opening, true, false],
    [Kind.Bet, true, false],
    [Kind.Win, true, false],
    [Kind.Loss, false, false],
    [Kind.Refund, true, true],
    [Kind.Rollback, true, true],
  ])('%s: affectsBalance=%p requiresReference=%p', (kind, affects, requires) => {
    const t = stored({ kind });
    expect(t.affectsBalance()).toBe(affects);
    expect(t.requiresReference()).toBe(requires);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Debit],
    [Kind.Win, LedgerDirection.Credit],
    [Kind.Refund, LedgerDirection.Credit],
    [Kind.Opening, LedgerDirection.Credit],
  ])('direção de %s é %s', (kind, direction) => {
    expect(stored({ kind }).ledgerDirectionFor()).toBe(direction);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])('ROLLBACK de %s é %s', (referenceKind, direction) => {
    expect(tx({ kind: Kind.Rollback }).ledgerDirectionFor(stored({ kind: referenceKind }))).toBe(direction);
  });

  test('LOSS e ROLLBACK sem referência não têm direção', () => {
    expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(DomainError);
    expect(() => tx({ kind: Kind.Rollback }).ledgerDirectionFor()).toThrow(DomainError);
  });

  test('códigos distintos para saldo insuficiente em BET e em reversão', () => {
    expect(tx().insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    expect(tx({ kind: Kind.Rollback }).insufficientFundsCode()).toBe(FailureCode.ReversalInsufficientFunds);
  });
});

test('taxonomia de FailureCode é exatamente a documentada', () => {
  expect<string[]>(Object.values(FailureCode).sort()).toEqual([
    'CURRENCY_MISMATCH',
    'INSUFFICIENT_FUNDS',
    'INTERNAL_ERROR',
    'REFERENCE_ALREADY_REVERSED',
    'REFERENCE_AMOUNT_MISMATCH',
    'REFERENCE_KIND_NOT_ALLOWED',
    'REFERENCE_MISMATCH',
    'REFERENCE_NOT_FOUND',
    'REFERENCE_NOT_PROCESSED',
    'REVERSAL_INSUFFICIENT_FUNDS',
    'WALLET_PLAYER_MISMATCH',
  ]);
  expect(JSON.stringify({ code: FailureCode.InsufficientFunds })).toBe('{"code":"INSUFFICIENT_FUNDS"}');
});

describe('tentativas de resolução da referência', () => {
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const pendingRefund = () => {
    const refund = tx({ kind: Kind.Refund });
    refund.markPendingReference();
    return refund;
  };

  test('transação nova: 0 tentativas e nenhuma próxima tentativa', () => {
    const refund = tx({ kind: Kind.Refund });
    expect(refund.referenceAttempts).toBe(0);
    expect(refund.nextReferenceAttemptAt).toBeUndefined();
  });

  test('cada tentativa incrementa e agenda com o backoff: +1s, +2s', () => {
    const refund = pendingRefund();
    refund.scheduleReferenceRetry(at(0), at(900));
    expect([refund.referenceAttempts, refund.nextReferenceAttemptAt]).toEqual([1, at(1)]);
    refund.scheduleReferenceRetry(at(10), at(900));
    expect([refund.referenceAttempts, refund.nextReferenceAttemptAt]).toEqual([2, at(12)]);
    expect(refund.status).toBe(Status.PendingReference);
  });

  test('a próxima tentativa não passa do limite informado', () => {
    const refund = stored({ kind: Kind.Refund, status: Status.PendingReference, processedAt: undefined, referenceAttempts: 9 });
    refund.scheduleReferenceRetry(at(898), at(900)); // o backoff sozinho daria +300s
    expect([refund.referenceAttempts, refund.nextReferenceAttemptAt]).toEqual([10, at(900)]);
  });

  test.each([
    ['PENDING', () => tx({ kind: Kind.Refund })],
    ['PROCESSED', () => stored({ kind: Kind.Refund })],
    ['REJECTED', () => stored({ kind: Kind.Refund, status: Status.Rejected, processedAt: undefined })],
  ])('fora de PENDING_REFERENCE (%s) falha sem alterar nada', (_name, make) => {
    const t = make();
    expect(() => t.scheduleReferenceRetry(at(0), at(900))).toThrow(DomainError);
    expect(t.referenceAttempts).toBe(0);
    expect(t.nextReferenceAttemptAt).toBeUndefined();
  });

  test('rehydrate preserva tentativas e próxima tentativa', () => {
    const t = stored({ kind: Kind.Refund, status: Status.PendingReference, processedAt: undefined, referenceAttempts: 3, nextReferenceAttemptAt: T1 });
    expect(t.referenceAttempts).toBe(3);
    expect(t.nextReferenceAttemptAt).toBe(T1);
  });
});
