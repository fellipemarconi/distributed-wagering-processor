import { expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { validateReference } from '../../src/domain/reference-validation';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { brl, stored, tx, usd } from './fixtures';

const OK = { outcome: 'ok' } as const;
const WAIT = { outcome: 'wait' } as const;
const reject = (code: FailureCode) => ({ outcome: 'reject', code }) as const;

const refund = () => tx({ kind: Kind.Refund });
const rollback = () => tx({ kind: Kind.Rollback });
const bet = stored; // BET PROCESSED de 25.00 BRL, mesma identidade dos fixtures

test('REFUND de BET PROCESSED, mesma identidade e valor, ainda não revertida: ok', () => {
  expect(validateReference(refund(), bet(), false)).toEqual(OK);
});

test('referência ausente: aguardar', () => {
  expect(validateReference(refund(), undefined, false)).toEqual(WAIT);
});

test.each([Status.Pending, Status.PendingReference])('referência em %s: aguardar', (status) => {
  expect(validateReference(refund(), bet({ status, processedAt: undefined }), false)).toEqual(WAIT);
});

test.each([
  ['provider', { providerId: 'provider-b' }],
  ['player', { playerId: 'p2' }],
  ['wallet', { walletId: 'w2' }],
  ['moeda', { money: usd('25.00') }],
  ['rodada', { roundId: 'round-2' }],
] as const)('referência de outro %s: REFERENCE_MISMATCH', (_name, overrides) => {
  expect(validateReference(refund(), bet(overrides), false)).toEqual(reject(FailureCode.ReferenceMismatch));
});

test.each([Kind.Win, Kind.Refund, Kind.Rollback, Kind.Loss, Kind.Opening])(
  'REFUND de %s: REFERENCE_KIND_NOT_ALLOWED',
  (kind) => {
    expect(validateReference(refund(), stored({ kind }), false)).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
  },
);

test.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK de %s: ok', (kind) => {
  expect(validateReference(rollback(), stored({ kind }), false)).toEqual(OK);
});

test.each([Kind.Loss, Kind.Rollback, Kind.Opening])('ROLLBACK de %s: REFERENCE_KIND_NOT_ALLOWED', (kind) => {
  expect(validateReference(rollback(), stored({ kind }), false)).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
});

test.each([Status.Rejected, Status.Failed])('referência em %s: REFERENCE_NOT_PROCESSED', (status) => {
  expect(validateReference(refund(), bet({ status }), false)).toEqual(reject(FailureCode.ReferenceNotProcessed));
});

test('referência já revertida: REFERENCE_ALREADY_REVERSED', () => {
  expect(validateReference(refund(), bet(), true)).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
  expect(validateReference(rollback(), bet(), true)).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
});

test('valor divergente: REFERENCE_AMOUNT_MISMATCH', () => {
  const partial = tx({ kind: Kind.Refund, money: brl('20.00') });
  expect(validateReference(partial, bet(), false)).toEqual(reject(FailureCode.ReferenceAmountMismatch));
  const partialRollback = tx({ kind: Kind.Rollback, money: brl('20.00') });
  expect(validateReference(partialRollback, bet(), false)).toEqual(reject(FailureCode.ReferenceAmountMismatch));
});

test('WIN referenciando a BET da rodada: ok sem exigir mesmo valor nem ausência de reversão', () => {
  const win = tx({ kind: Kind.Win, money: brl('60.00'), referenceExternalTransactionId: 'ext-BET' });
  expect(validateReference(win, bet(), false)).toEqual(OK);
  expect(validateReference(win, bet(), true)).toEqual(OK);
});

test('WIN referenciando algo que não é BET: REFERENCE_KIND_NOT_ALLOWED', () => {
  const win = tx({ kind: Kind.Win, referenceExternalTransactionId: 'ext-WIN' });
  expect(validateReference(win, stored({ kind: Kind.Win }), false)).toEqual(
    reject(FailureCode.ReferenceKindNotAllowed),
  );
});

test('ordem das verificações: identidade > tipo > estado > já revertida > valor', () => {
  const partial = tx({ kind: Kind.Refund, money: brl('20.00') });
  const pending = { status: Status.Pending, processedAt: undefined };
  // tudo errado ao mesmo tempo: identidade decide
  expect(validateReference(partial, stored({ kind: Kind.Win, roundId: 'round-2', ...pending }), true)).toEqual(
    reject(FailureCode.ReferenceMismatch),
  );
  // tipo errado e ainda pendente: rejeita na hora em vez de aguardar
  expect(validateReference(partial, stored({ kind: Kind.Win, ...pending }), true)).toEqual(
    reject(FailureCode.ReferenceKindNotAllowed),
  );
  // pendente, já revertida e valor divergente: aguarda
  expect(validateReference(partial, bet(pending), true)).toEqual(WAIT);
  // já revertida e valor divergente: já revertida decide
  expect(validateReference(partial, bet(), true)).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
});
