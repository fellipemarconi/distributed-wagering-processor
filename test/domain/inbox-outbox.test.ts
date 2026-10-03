import { describe, expect, test } from 'bun:test';
import { backoffDelayMs } from '../../src/domain/backoff';
import { DomainError } from '../../src/domain/errors';
import { InboxMessage } from '../../src/domain/inbox-message';
import { WagerTransactionProcessed } from '../../src/domain/integration-events';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { brl, T0, T1, tx } from './fixtures';

const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

describe('InboxMessage', () => {
  const receive = () =>
    InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'abc', receivedAt: T0 });

  test('nasce não processada', () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('é processada uma única vez', () => {
    const message = receive();
    message.markProcessed(T1);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(T1);
    expect(() => message.markProcessed(after(T1, 1000))).toThrow(DomainError);
    expect(message.processedAt).toBe(T1);
  });

  test('rehydrate preserva o estado', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'abc',
      receivedAt: T0,
      processedAt: T1,
    });
    expect(message.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  function event() {
    const bet = tx();
    bet.markProcessed(undefined, brl('75.00'), T1);
    return WagerTransactionProcessed.from(bet, { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T1 });
  }
  const enqueue = () => OutboxMessage.enqueue(event());

  test('enqueue: pendente, 0 tentativas, vencida de imediato, payload = envelope do evento', () => {
    const message = enqueue();
    expect(message).toMatchObject({
      id: 'evt-1',
      aggregateId: 'tx-BET',
      eventType: 'WagerTransactionProcessed',
      occurredAt: T1,
    });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T1)).toBe(true);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.payload).toEqual(event().toJSON());
    expect(JSON.parse(JSON.stringify(message.payload))).toEqual(message.payload);
  });

  test('publicada: deixa de estar pendente e vencida', () => {
    const message = enqueue();
    message.markPublished(T1);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(after(T1, 60_000))).toBe(false);
    expect(message.publishedAt).toBe(T1);
  });

  test('publicar ou reagendar mensagem já publicada falha', () => {
    const message = enqueue();
    message.markPublished(T1);
    expect(() => message.markPublished(after(T1, 1))).toThrow(DomainError);
    expect(() => message.scheduleRetry(after(T1, 1))).toThrow(DomainError);
    expect(message.publishedAt).toBe(T1);
    expect(message.attempts).toBe(0);
  });

  test('scheduleRetry: incrementa attempts e dobra o atraso a partir de 1s', () => {
    const message = enqueue();
    const delays = [1, 2, 3, 4, 5].map((attempt) => {
      message.scheduleRetry(T1);
      expect(message.attempts).toBe(attempt);
      return message.nextAttemptAt!.getTime() - T1.getTime();
    });
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  test('teto de 5 minutos', () => {
    const message = OutboxMessage.rehydrate({
      id: 'evt-1',
      aggregateId: 'tx-BET',
      eventType: 'WagerTransactionProcessed',
      payload: {},
      occurredAt: T0,
      attempts: 19,
    });
    message.scheduleRetry(T1);
    expect(message.attempts).toBe(20);
    expect(message.nextAttemptAt).toEqual(after(T1, 300_000));
    expect(backoffDelayMs(9)).toBe(256_000);
    expect(backoffDelayMs(10)).toBe(300_000);
    expect(backoffDelayMs(1000)).toBe(300_000);
    expect(backoffDelayMs(0)).toBe(1_000);
  });

  test('isDue: só vence quando o instante atinge nextAttemptAt', () => {
    const message = enqueue();
    message.scheduleRetry(T1); // próxima em T1 + 1s
    expect(message.isPending()).toBe(true);
    expect(message.isDue(after(T1, 999))).toBe(false);
    expect(message.isDue(after(T1, 1_000))).toBe(true);
    expect(message.isDue(after(T1, 5_000))).toBe(true);
  });
});
