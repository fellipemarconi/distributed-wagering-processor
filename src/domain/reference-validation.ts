import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-transaction';

export type ReferenceCheck =
  | { outcome: 'ok' }
  | { outcome: 'wait' } // referência ausente ou ainda não finalizada: PENDING_REFERENCE
  | { outcome: 'reject'; code: FailureCode };

const ALLOWED_REFERENCE_KINDS: Partial<Record<Kind, Kind[]>> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
};

const reject = (code: FailureCode): ReferenceCheck => ({ outcome: 'reject', code });

/**
 * Regras de referência (CHALLENGE §7). Ordem fixa: existência, identidade, tipo, estado,
 * reversão anterior, valor. Identidade e tipo vêm antes do estado para rejeitar uma
 * referência errada na hora, sem esperar ela finalizar.
 *
 * `referenceAlreadyReversed`: já existe REFUND ou ROLLBACK aplicado sobre a referência.
 * Mais estrito que o enunciado ("pelo mesmo tipo"): REFUND + ROLLBACK da mesma BET
 * creditaria a aposta duas vezes.
 */
export function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  referenceAlreadyReversed: boolean,
): ReferenceCheck {
  if (!reference) return { outcome: 'wait' };

  if (
    reference.providerId !== tx.providerId ||
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.money.currency !== tx.money.currency ||
    reference.roundId !== tx.roundId
  ) {
    return reject(FailureCode.ReferenceMismatch);
  }

  if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(reference.kind)) {
    return reject(FailureCode.ReferenceKindNotAllowed);
  }

  if (!reference.isTerminal()) return { outcome: 'wait' };
  if (reference.status !== Status.Processed) return reject(FailureCode.ReferenceNotProcessed);

  // WIN/LOSS só apontam para a BET da rodada: não a revertem nem precisam ter o mesmo valor.
  if (tx.requiresReference()) {
    if (referenceAlreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
    if (!reference.money.equals(tx.money)) return reject(FailureCode.ReferenceAmountMismatch);
  }

  return { outcome: 'ok' };
}
