import { backoffDelayMs } from './backoff';
import { DomainError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';
import { computePayloadHash } from './payload-hash';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  completedAt?: Date;
  /** Tentativas de resolver a referência que terminaram em "ainda ausente". Padrão 0. */
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
}

/** Reservado para transações internas (OPENING); recusado em entrada externa. */
export const INTERNAL_PROVIDER_ID = 'internal';
const INTERNAL = INTERNAL_PROVIDER_ID;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _completedAt?: Date,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Entrada externa (API/fila). Nasce em PENDING. OPENING não entra por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;
    if (kind === WagerTransactionKind.Opening) {
      throw new DomainError('OPENING é interno e não pode ser submetido externamente');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new DomainError(`providerId "${INTERNAL_PROVIDER_ID}" é reservado para transações internas`);
    }
    const tx = WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending });
    if (tx.requiresReference() && reference === undefined) {
      throw new DomainError(`${kind} exige referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new DomainError('BET não aceita referência');
    }
    if (money.isNegative() || (money.isZero() && tx.affectsBalance())) {
      throw new DomainError(`${kind} exige valor positivo`);
    }
    return tx;
  }

  /** Caminho interno: crédito de abertura da wallet. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) throw new DomainError('OPENING exige valor positivo');
    const business = {
      providerId: INTERNAL,
      externalTransactionId: `opening:${props.walletId}`,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: INTERNAL,
      gameId: INTERNAL,
      kind: WagerTransactionKind.Opening,
    };
    return WagerTransaction.rehydrate({
      ...business,
      id: props.id,
      idempotencyKey: business.externalTransactionId,
      payloadHash: computePayloadHash({ ...business, money: props.money.toJSON() }),
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Reconstrução a partir da persistência — não revalida criação nem transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.completedAt,
      s.referenceAttempts ?? 0,
      s.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  /** Saldo da wallet observado no momento da decisão — devolvido no replay idempotente (§7 regra 7). */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  /** Instante em que chegou a um estado terminal, qualquer que seja. */
  get completedAt(): Date | undefined {
    return this._completedAt;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  /** Ausente = nunca tentada: vencida de imediato. */
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições: PENDING e PENDING_REFERENCE vão para qualquer estado abaixo; terminais não saem.

  /** `balanceAfter`: saldo da wallet depois de aplicada (para LOSS, o saldo inalterado). */
  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal();
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new DomainError(`${this.kind} não pode ser processada sem a referência resolvida`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this.complete(balanceAfter, at);
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    if (this.referenceExternalTransactionId === undefined) {
      throw new DomainError(`${this.kind} sem referência não pode aguardar referência`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Referência ainda ausente: conta a tentativa e agenda a próxima com o backoff da outbox, sem
   * passar de `notAfter` (fim do prazo de espera) — a rejeição por prazo sai no prazo.
   */
  scheduleReferenceRetry(now: Date, notAfter: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new DomainError(`Transação ${this.id} não está aguardando referência`);
    }
    this._referenceAttempts += 1;
    const next = now.getTime() + backoffDelayMs(this._referenceAttempts);
    this._nextReferenceAttemptAt = new Date(Math.min(next, notAfter.getTime()));
  }

  /** `observedBalance`: saldo da wallet no momento da rejeição (rejeição não o altera). */
  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this.complete(observedBalance, at);
  }

  // Sem saldo: erro de infraestrutura pode ocorrer antes de a wallet ser lida.
  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.complete(undefined, at);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Mesma idempotency key com hash diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new DomainError('ROLLBACK precisa da referência para definir a direção');
        // Sem recursão: ROLLBACK só referencia BET/WIN/REFUND, que têm direção própria.
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new DomainError('LOSS não movimenta saldo');
    }
  }

  /** Aposta sem saldo e reversão sem saldo são situações operacionalmente diferentes. */
  insufficientFundsCode(): FailureCode {
    return this.kind === WagerTransactionKind.Bet
      ? FailureCode.InsufficientFunds
      : FailureCode.ReversalInsufficientFunds;
  }

  private complete(resultBalance: Money | undefined, at: Date): void {
    this._resultBalance = resultBalance;
    this._completedAt = at;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transação ${this.id} já está em ${this._status}`);
    }
  }
}
