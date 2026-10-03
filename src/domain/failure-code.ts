// Taxonomia estável: o valor é o contrato com o provedor. Só se adiciona; nunca se renomeia
// nem se reaproveita um código. Significados e ação esperada do provedor: design.md (D7).
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  InternalError = 'INTERNAL_ERROR',
}
