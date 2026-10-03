import type { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas';

// Registro (linha) ⇄ agregado. Leitura sempre via rehydrate: nada é revalidado.
// kind/status/direction/failureCode voltam por cast — o CHECK do banco garante o conjunto.

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const amountOf = (m: Money) => m.toJSON().amount;
const opt = <T>(value: T | null): T | undefined => value ?? undefined;

export const walletMapper = {
  toRecord: (w: Wallet): WalletRecord => ({
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: amountOf(w.balance),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }),
  toDomain: (r: WalletRecord): Wallet =>
    Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }),
};

export const wagerTransactionMapper = {
  /** Colunas que mudam depois do INSERT — o que `save` grava. */
  toMutableRecord: (t: WagerTransaction) => ({
    status: t.status as string,
    referenceTransactionId: t.referenceTransactionId ?? null,
    failureCode: (t.failureCode as string | undefined) ?? null,
    processedAt: t.processedAt ?? null,
    completedAt: t.completedAt ?? null,
    resultBalanceAmount: t.resultBalance ? amountOf(t.resultBalance) : null,
    resultBalanceCurrency: t.resultBalance?.currency ?? null,
  }),
  toRecord: (t: WagerTransaction): WagerTransactionRecord => ({
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: amountOf(t.money),
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    createdAt: t.createdAt,
    ...wagerTransactionMapper.toMutableRecord(t),
  }),
  toDomain: (r: WagerTransactionRecord): WagerTransaction =>
    WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: opt(r.referenceTransactionId),
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      processedAt: opt(r.processedAt),
      resultBalance:
        r.resultBalanceAmount !== null && r.resultBalanceCurrency !== null
          ? money(r.resultBalanceAmount, r.resultBalanceCurrency)
          : undefined,
      completedAt: opt(r.completedAt),
    }),
};

export const ledgerEntryMapper = {
  toRecord: (e: WalletLedgerEntry): LedgerEntryRecord => ({
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: amountOf(e.money),
    currency: e.money.currency,
    balanceBefore: amountOf(e.balanceBefore),
    balanceAfter: amountOf(e.balanceAfter),
    createdAt: e.createdAt,
  }),
  toDomain: (r: LedgerEntryRecord): WalletLedgerEntry =>
    WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      createdAt: r.createdAt,
    }),
};

export const inboxMessageMapper = {
  toRecord: (m: InboxMessage): InboxMessageRecord => ({
    consumerName: m.consumerName,
    messageId: m.messageId,
    payloadHash: m.payloadHash,
    receivedAt: m.receivedAt,
    processedAt: m.processedAt ?? null,
  }),
  toDomain: (r: InboxMessageRecord): InboxMessage =>
    InboxMessage.rehydrate({
      messageId: r.messageId,
      consumerName: r.consumerName,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: opt(r.processedAt),
    }),
};

export const outboxMessageMapper = {
  toMutableRecord: (m: OutboxMessage) => ({
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt ?? null,
    publishedAt: m.publishedAt ?? null,
  }),
  toRecord: (m: OutboxMessage): OutboxMessageRecord => ({
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    // cópia: o payload do evento é congelado em profundidade e o MikroORM muta os parâmetros
    payload: structuredClone(m.payload) as Record<string, unknown>,
    occurredAt: m.occurredAt,
    ...outboxMessageMapper.toMutableRecord(m),
  }),
  toDomain: (r: OutboxMessageRecord): OutboxMessage =>
    OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: opt(r.nextAttemptAt),
      publishedAt: opt(r.publishedAt),
    }),
};
