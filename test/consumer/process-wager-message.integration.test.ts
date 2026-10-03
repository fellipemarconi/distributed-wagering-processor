import { afterAll, describe, expect, test } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { InboxRepository } from '../../src/application/ports';
import { MikroOrmInboxRepository } from '../../src/infra/persistence/repositories';
import {
  balanceOf,
  boot,
  countRows,
  eventsOf,
  expectLedgerInvariant,
  ledgerOf,
  openWallet,
  payload,
  submit,
  uuid,
} from '../application/helpers';
import { sql } from '../persistence/helpers';
import { envelope, handle, inboxOf, transactionsOf } from './helpers';

const app = await boot();
afterAll(() => app.close());

test('mensagem processada: transação, lançamento, saldo, inbox e eventos em um commit, correlacionados pelo messageId', async () => {
  const w = await openWallet(app, '100.00');
  const data = payload(w);
  const message = envelope(data);

  const result = await handle(app, message);

  if (result.outcome !== 'processed') throw new Error(`esperava processed, veio ${result.outcome}`);
  expect(result.messageId).toBe(message.messageId);
  expect(await balanceOf(app, w.id)).toBe('75.00');
  expect((await ledgerOf(app, w.id)).at(-1)).toMatchObject({ direction: 'DEBIT', amount: '25.00', transaction_id: result.transaction.id });
  expect(await eventsOf(app, result.transaction.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

  const [inbox] = await inboxOf(app, message.messageId);
  expect(inbox!.processed_at).not.toBeNull();

  const events = await sql<{ correlation: string; causation: string }>(
    app.get(MikroORM),
    `select payload->>'correlationId' as correlation, payload->>'causationId' as causation
       from outbox_messages where aggregate_id = ? or payload->'data'->>'transactionId' = ?`,
    [result.transaction.id, result.transaction.id],
  );
  expect(events).toHaveLength(2);
  for (const event of events) expect(event).toEqual({ correlation: message.messageId, causation: message.messageId });
  await expectLedgerInvariant(app, w.id);
});

test('mesma mensagem duas vezes: a segunda é duplicata e não há segundo efeito', async () => {
  const w = await openWallet(app, '100.00');
  const data = payload(w);
  const message = envelope(data);

  expect((await handle(app, message)).outcome).toBe('processed');
  expect(await handle(app, message)).toEqual({ outcome: 'duplicate', messageId: message.messageId });

  expect(await balanceOf(app, w.id)).toBe('75.00');
  expect(await transactionsOf(app, data.externalTransactionId)).toHaveLength(1);
  expect(await inboxOf(app, message.messageId)).toHaveLength(1);
  await expectLedgerInvariant(app, w.id);
});

test('rejeição de negócio e referência pendente gravam a inbox', async () => {
  const w = await openWallet(app, '10.00');
  const bet = envelope(payload(w)); // 25.00 > 10.00
  const refund = envelope(payload(w, { kind: 'REFUND', referenceExternalTransactionId: uuid() }));

  const rejected = await handle(app, bet);
  const pending = await handle(app, refund);

  if (rejected.outcome !== 'rejected' || pending.outcome !== 'pending') throw new Error('desfecho inesperado');
  expect(rejected.transaction.failureCode as string).toBe('INSUFFICIENT_FUNDS');
  expect(await eventsOf(app, rejected.transaction.id)).toEqual(['WagerTransactionRejected']);
  expect(await inboxOf(app, bet.messageId)).toHaveLength(1);
  expect(await inboxOf(app, refund.messageId)).toHaveLength(1);
  expect(await balanceOf(app, w.id)).toBe('10.00');
  await expectLedgerInvariant(app, w.id);
});

test('replay de transação criada por outro canal: grava a inbox e nenhum evento novo', async () => {
  const w = await openWallet(app, '100.00');
  const data = payload(w);
  const first = await submit(app, data);
  if (first.outcome !== 'processed') throw new Error('preparo falhou');
  const message = envelope(data);

  const result = await handle(app, message);

  if (result.outcome !== 'replay') throw new Error(`esperava replay, veio ${result.outcome}`);
  expect(result.transaction.id).toBe(first.transaction.id);
  expect(await inboxOf(app, message.messageId)).toHaveLength(1);
  expect(await eventsOf(app, first.transaction.id)).toHaveLength(2);
  expect(await balanceOf(app, w.id)).toBe('75.00');
  await expectLedgerInvariant(app, w.id);
});

describe('mensagem que nunca será processada', () => {
  const noInbox = async (messageId: string) => expect(await inboxOf(app, messageId)).toEqual([]);

  test('corpo que não é JSON, tipo errado, messageId ausente, occurredAt inválido, data ausente → INVALID_ENVELOPE', async () => {
    const w = await openWallet(app);
    const valid = envelope(payload(w));
    const bodies = [
      'isto não é json',
      '[]',
      { ...valid, type: 'OutraCoisa' },
      { ...valid, messageId: undefined },
      { ...valid, messageId: '   ' },
      { ...valid, occurredAt: 'ontem' },
      { ...valid, data: 'texto' },
    ];
    for (const body of bodies) {
      expect(await handle(app, body)).toEqual({ outcome: 'dead', reason: 'INVALID_ENVELOPE' });
    }
    expect(await balanceOf(app, w.id)).toBe('100.00');
  });

  test.each([
    ['valor monetário inválido', { money: { amount: '25.001', currency: 'BRL' } }],
    ['campo obrigatório ausente', { roundId: undefined }],
    ['chave de idempotência ausente', { idempotencyKey: undefined }],
    ['OPENING pela fila', { kind: 'OPENING' }],
  ])('%s → INVALID_PAYLOAD, nada gravado', async (_name, override) => {
    const w = await openWallet(app);
    const data = { ...payload(w), ...override };
    const message = envelope(data);

    expect(await handle(app, message)).toEqual({ outcome: 'dead', reason: 'INVALID_PAYLOAD', messageId: message.messageId });

    await noInbox(message.messageId);
    expect(await transactionsOf(app, data.externalTransactionId)).toEqual([]);
    expect(await balanceOf(app, w.id)).toBe('100.00');
  });

  test('wallet inexistente → WALLET_NOT_FOUND', async () => {
    const message = envelope(payload({ id: uuid(), playerId: uuid() }));

    expect(await handle(app, message)).toEqual({ outcome: 'dead', reason: 'WALLET_NOT_FOUND', messageId: message.messageId });
    await noInbox(message.messageId);
  });

  test('conflitos de idempotência → reason com o código, transação original intacta', async () => {
    const w = await openWallet(app, '100.00');
    const original = payload(w);
    await handle(app, envelope(original));

    const otherPayload = envelope({ ...original, money: { amount: '30.00', currency: 'BRL' } });
    const otherKey = envelope({ ...original, idempotencyKey: `outra-${uuid()}` });

    expect(await handle(app, otherPayload)).toEqual({ outcome: 'dead', reason: 'IDEMPOTENCY_KEY_CONFLICT', messageId: otherPayload.messageId });
    expect(await handle(app, otherKey)).toEqual({ outcome: 'dead', reason: 'EXTERNAL_TRANSACTION_CONFLICT', messageId: otherKey.messageId });

    await noInbox(otherPayload.messageId);
    await noInbox(otherKey.messageId);
    expect(await transactionsOf(app, original.externalTransactionId)).toHaveLength(1);
    expect(await balanceOf(app, w.id)).toBe('75.00');
    await expectLedgerInvariant(app, w.id);
  });
});

test('falha ao gravar a inbox desfaz a transação financeira, o lançamento e os eventos', async () => {
  const boom = new Error('inbox indisponível');
  const failing = await boot({}, (builder) =>
    builder.overrideProvider(InboxRepository).useFactory({
      inject: [EntityManager],
      factory: (em: EntityManager): InboxRepository =>
        Object.assign(Object.create(new MikroOrmInboxRepository(em)) as InboxRepository, {
          add: () => Promise.reject(boom),
        }),
    }),
  );
  try {
    const w = await openWallet(app, '100.00');
    const data = payload(w);

    await expect(handle(failing, envelope(data))).rejects.toBe(boom);

    expect(await transactionsOf(app, data.externalTransactionId)).toEqual([]);
    expect(await ledgerOf(app, w.id)).toHaveLength(1); // só o crédito de abertura
    expect(await countRows(app, 'outbox_messages', `payload->'data'->>'externalTransactionId' = ?`, [data.externalTransactionId])).toBe(0);
    expect(await balanceOf(app, w.id)).toBe('100.00');
    await expectLedgerInvariant(app, w.id);
  } finally {
    await failing.close();
  }
});

test('a mesma mensagem 20 vezes em paralelo: um efeito, uma linha de inbox, o resto duplicata', async () => {
  const w = await openWallet(app, '100.00');
  const data = payload(w);
  const message = envelope(data);

  const results = await Promise.all(Array.from({ length: 20 }, () => handle(app, message)));

  expect(results.filter((r) => r.outcome === 'processed')).toHaveLength(1);
  expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(19);
  expect(await inboxOf(app, message.messageId)).toHaveLength(1);
  expect(await transactionsOf(app, data.externalTransactionId)).toHaveLength(1);
  expect(await ledgerOf(app, w.id)).toHaveLength(2);
  expect(await balanceOf(app, w.id)).toBe('75.00');
  await expectLedgerInvariant(app, w.id);
});

test('mesma chave em wallets diferentes (corrida fora do lock) dentro da transação da inbox: uma gravada, outra conflito', async () => {
  for (let round = 0; round < 10; round++) {
    const [a, b] = await Promise.all([openWallet(app), openWallet(app)]);
    const first = payload(a);
    const second = { ...payload(b), externalTransactionId: first.externalTransactionId, idempotencyKey: first.idempotencyKey };

    // a releitura do use case acontece em savepoint: não pode estourar "transaction is aborted"
    const results = await Promise.all([handle(app, envelope(first)), handle(app, envelope(second))]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['dead', 'processed']);
    expect(results.find((r) => r.outcome === 'dead')).toMatchObject({ reason: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await transactionsOf(app, first.externalTransactionId)).toHaveLength(1);
    await expectLedgerInvariant(app, a.id);
    await expectLedgerInvariant(app, b.id);
  }
});
