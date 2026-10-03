import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UniqueViolationError } from '../../src/application/ports';
import { InsufficientFundsError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { InboxMessage } from '../../src/domain/inbox-message';
import { WalletBalanceChanged } from '../../src/domain/integration-events';
import { OutboxMessage } from '../../src/domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmTransactionRunner,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from '../../src/infra/persistence/repositories';
import { brl, txProps, usd } from '../domain/fixtures';
import { initOrm, resetSchema, sql, uuid } from './helpers';

const orm = await initOrm();
beforeAll(() => resetSchema(orm));
afterAll(() => orm.close());

// EM global, como no Nest: a transação aberta por run() é resolvida por AsyncLocalStorage.
const runner = new MikroOrmTransactionRunner(orm.em);
const wallets = new MikroOrmWalletRepository(orm.em);
const transactions = new MikroOrmWagerTransactionRepository(orm.em);
const ledger = new MikroOrmLedgerRepository(orm.em);
const inbox = new MikroOrmInboxRepository(orm.em);
const outbox = new MikroOrmOutboxRepository(orm.em);

const now = () => new Date();
const movement = (transactionId: string) => ({ entryId: uuid(), transactionId, at: now() });

function newWallet(balance = brl('100.00')): Wallet {
  return Wallet.rehydrate({ id: uuid(), playerId: uuid(), balance, version: 1, createdAt: now(), updatedAt: now() });
}

async function storedWallet(balance = brl('100.00')): Promise<Wallet> {
  const wallet = newWallet(balance);
  await wallets.add(wallet);
  return wallet;
}

function newTx(wallet: Wallet, overrides: Parameters<typeof txProps>[0] = {}): WagerTransaction {
  return WagerTransaction.create(
    txProps({
      id: uuid(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: uuid(),
      createdAt: now(),
      ...overrides,
    }),
  );
}

/** Wallet aberta com saldo + transação OPENING processada + lançamento + evento, como o use case fará. */
function opening() {
  const walletId = uuid();
  const tx = WagerTransaction.opening({ id: uuid(), walletId, playerId: uuid(), money: brl('1000.00'), createdAt: now() });
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: tx.playerId,
    initialBalance: tx.money,
    at: now(),
    opening: { entryId: uuid(), transactionId: tx.id },
  });
  tx.markProcessed(undefined, wallet.balance, now());
  const event = WalletBalanceChanged.from(wallet, openingEntry!, { eventId: uuid(), correlationId: uuid(), occurredAt: now() });
  return { wallet, tx, entry: openingEntry!, event, message: OutboxMessage.enqueue(event) };
}

describe('round-trip', () => {
  test('wallet', async () => {
    const { wallet } = opening();
    await wallets.add(wallet);

    const read = await wallets.findById(wallet.id);
    expect(read).toEqual(wallet);
    expect(read!.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(read!.version).toBe(1);
  });

  test('wallet inexistente é ausência', async () => {
    expect(await wallets.findById(uuid())).toBeUndefined();
  });

  test('transação em cada estado', async () => {
    const wallet = await storedWallet();
    const roundTrip = async (tx: WagerTransaction, transition?: (tx: WagerTransaction) => void) => {
      await transactions.add(tx);
      expect(await transactions.findById(tx.id)).toEqual(tx); // PENDING
      if (transition) {
        transition(tx);
        await transactions.save(tx);
      }
      const read = (await transactions.findById(tx.id))!;
      expect(read).toEqual(tx);
      return read;
    };

    const pending = await roundTrip(newTx(wallet));
    expect(pending.processedAt).toBeUndefined();
    expect(pending.failureCode).toBeUndefined();
    expect(pending.resultBalance).toBeUndefined();
    expect(pending.referenceExternalTransactionId).toBeUndefined();

    const bet = await roundTrip(newTx(wallet), (tx) => tx.markProcessed(undefined, brl('75.00'), now()));
    expect(bet.resultBalance!.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });

    const refund = () => newTx(wallet, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const waiting = await roundTrip(refund(), (tx) => tx.markPendingReference());
    expect(waiting.status).toBe(Status.PendingReference);
    const refunded = await roundTrip(refund(), (tx) => tx.markProcessed(bet.id, brl('100.00'), now()));
    expect(refunded.referenceTransactionId).toBe(bet.id);

    const rejected = await roundTrip(newTx(wallet), (tx) => tx.reject(FailureCode.InsufficientFunds, brl('10.00'), now()));
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.processedAt).toBeUndefined();

    const failed = await roundTrip(newTx(wallet), (tx) => tx.fail(FailureCode.InternalError, now()));
    expect(failed.resultBalance).toBeUndefined();
    expect(failed.completedAt).toBeInstanceOf(Date);
  });

  test('saldo resultante em moeda diferente da transação', async () => {
    const wallet = await storedWallet();
    const tx = newTx(wallet, { money: usd('5.00') });
    await transactions.add(tx);
    tx.reject(FailureCode.CurrencyMismatch, brl('10.00'), now());
    await transactions.save(tx);

    const read = (await transactions.findById(tx.id))!;
    expect(read.money.toJSON()).toEqual({ amount: '5.00', currency: 'USD' });
    expect(read.resultBalance!.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('segunda reversão aplicada é recusada com a constraint identificada', async () => {
    const wallet = await storedWallet();
    const bet = newTx(wallet);
    await transactions.add(bet);
    bet.markProcessed(undefined, brl('75.00'), now());
    await transactions.save(bet);
    const reversal = async (kind: Kind) => {
      const tx = newTx(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });
      await transactions.add(tx);
      tx.markProcessed(bet.id, brl('100.00'), now());
      return transactions.save(tx);
    };

    await reversal(Kind.Refund);
    const error = await reversal(Kind.Rollback).catch((e) => e);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error.constraint).toBe('uq_wager_tx_processed_reversal');
  });

  test('hasProcessedReversalOf só conta REFUND/ROLLBACK aplicados', async () => {
    const wallet = await storedWallet();
    const bet = newTx(wallet);
    await transactions.add(bet);
    bet.markProcessed(undefined, brl('75.00'), now());
    await transactions.save(bet);
    const referencing = async (kind: Kind, transition: (tx: WagerTransaction) => void) => {
      const tx = newTx(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });
      await transactions.add(tx);
      transition(tx);
      await transactions.save(tx);
    };

    await referencing(Kind.Win, (tx) => tx.markProcessed(bet.id, brl('100.00'), now()));
    await referencing(Kind.Refund, (tx) => tx.reject(FailureCode.ReferenceAmountMismatch, brl('75.00'), now()));
    await referencing(Kind.Rollback, (tx) => tx.markPendingReference());
    expect(await transactions.hasProcessedReversalOf(bet.id)).toBe(false);

    await referencing(Kind.Refund, (tx) => tx.markProcessed(bet.id, brl('100.00'), now()));
    expect(await transactions.hasProcessedReversalOf(bet.id)).toBe(true);
  });

  test('lançamento de ledger', async () => {
    const wallet = await storedWallet();
    const tx = newTx(wallet);
    await transactions.add(tx);
    const entry = wallet.debit(tx.money, movement(tx.id));
    await ledger.append(entry);

    const { entries, nextCursor } = await ledger.listByWallet(wallet.id, { limit: 10 });
    expect(entries).toEqual([entry]);
    expect(entries[0]!.isBalanced()).toBe(true);
    expect(nextCursor).toBeUndefined();
  });

  test('inbox', async () => {
    const message = InboxMessage.receive({ messageId: uuid(), consumerName: 'wagering', payloadHash: 'hash', receivedAt: now() });
    await inbox.add(message);
    expect(await inbox.find('wagering', message.messageId)).toEqual(message);
    expect((await inbox.find('wagering', message.messageId))!.isProcessed()).toBe(false);

    message.markProcessed(now());
    await inbox.save(message);
    expect(await inbox.find('wagering', message.messageId)).toEqual(message);
    expect(await inbox.find('outro-consumidor', message.messageId)).toBeUndefined();
  });

  test('outbox', async () => {
    const { event, message } = opening();
    await outbox.add(message);
    const pending = (await outbox.findById(message.id))!;
    expect(pending).toEqual(message);
    expect(pending.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(pending.nextAttemptAt).toBeUndefined();

    message.scheduleRetry(now());
    await outbox.save(message);
    expect(await outbox.findById(message.id)).toEqual(message);

    message.markPublished(now());
    await outbox.save(message);
    const published = (await outbox.findById(message.id))!;
    expect(published).toEqual(message);
    expect(published.isPending()).toBe(false);
  });

  test('save de agregado inexistente é erro, não no-op', async () => {
    await expect(wallets.save(newWallet())).rejects.toThrow(/esperava atualizar 1 linha/);
  });
});

describe('dinheiro exato', () => {
  test('0.10 + 0.20 passando pelo banco é 0.30', async () => {
    const wallet = await storedWallet(brl('0.10'));
    const tx = newTx(wallet, { kind: Kind.Win, money: brl('0.20') });
    await transactions.add(tx);

    const loaded = (await wallets.findById(wallet.id))!;
    await ledger.append(loaded.credit(tx.money, movement(tx.id)));
    await wallets.save(loaded);

    const read = (await wallets.findById(wallet.id))!;
    expect(read.balance.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(read.version).toBe(2);
  });

  test('valor no limite da coluna volta exato', async () => {
    const wallet = await storedWallet(brl('99999999999999999.99'));
    expect((await wallets.findById(wallet.id))!.balance.toJSON().amount).toBe('99999999999999999.99');
  });
});

describe('busca de transações', () => {
  test('por provedor + id externo e por provedor + chave de idempotência', async () => {
    const wallet = await storedWallet();
    const tx = newTx(wallet);
    await transactions.add(tx);

    expect(await transactions.findByExternalId(tx.providerId, tx.externalTransactionId)).toEqual(tx);
    expect(await transactions.findByIdempotencyKey(tx.providerId, tx.idempotencyKey)).toEqual(tx);
    expect(await transactions.findByExternalId('provider-x', tx.externalTransactionId)).toBeUndefined();
    expect(await transactions.findByIdempotencyKey(tx.providerId, 'inexistente')).toBeUndefined();
    expect(await transactions.findById(uuid())).toBeUndefined();
  });

  test('mesma chave de idempotência em provedores diferentes não se confunde', async () => {
    const wallet = await storedWallet();
    const idempotencyKey = uuid();
    const a = newTx(wallet, { providerId: 'provider-a', idempotencyKey });
    const b = newTx(wallet, { providerId: 'provider-b', idempotencyKey });
    await transactions.add(a);
    await transactions.add(b);

    expect((await transactions.findByIdempotencyKey('provider-a', idempotencyKey))!.id).toBe(a.id);
    expect((await transactions.findByIdempotencyKey('provider-b', idempotencyKey))!.id).toBe(b.id);
  });
});

describe('violação de unicidade identificável', () => {
  test('wallet duplicada', async () => {
    const wallet = await storedWallet();
    const duplicate = Wallet.rehydrate({ id: uuid(), playerId: wallet.playerId, balance: brl('1.00'), version: 1, createdAt: now(), updatedAt: now() });

    const error = await wallets.add(duplicate).catch((e) => e);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error.constraint).toBe('uq_wallets_player_currency');
  });

  test('chave de idempotência repetida no mesmo provedor', async () => {
    const wallet = await storedWallet();
    const tx = newTx(wallet);
    await transactions.add(tx);

    const error = await transactions.add(newTx(wallet, { idempotencyKey: tx.idempotencyKey })).catch((e) => e);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error.constraint).toBe('uq_wager_tx_provider_idempotency_key');
  });
});

describe('leitura de wallet com lock exclusivo', () => {
  /** Abre transação, trava a wallet, avisa, segura até `release` e só então debita. */
  function debitHolding(walletId: string, amount: string, release: Promise<void> = Promise.resolve()) {
    const locked = Promise.withResolvers<string>();
    const done = runner.run(async () => {
      const wallet = (await wallets.findByIdForUpdate(walletId))!;
      locked.resolve(wallet.balance.toJSON().amount);
      await release;
      wallet.debit(brl(amount), movement(uuid()));
      await wallets.save(wallet);
    });
    done.catch(() => {}); // rejeição tratada por quem aguarda `done`
    return { observedBalance: locked.promise, done };
  }

  test('segunda transação espera o commit da primeira e enxerga o saldo novo', async () => {
    const wallet = await storedWallet(brl('100.00'));
    const gate = Promise.withResolvers<void>();

    const first = debitHolding(wallet.id, '80.00', gate.promise);
    expect(await first.observedBalance).toBe('100.00');

    const second = debitHolding(wallet.id, '80.00');
    let secondLocked = false;
    void second.observedBalance.then(() => (secondLocked = true));
    await Bun.sleep(200);
    expect(secondLocked).toBe(false); // bloqueada no FOR UPDATE

    gate.resolve();
    await first.done;
    expect(await second.observedBalance).toBe('20.00');
    await expect(second.done).rejects.toBeInstanceOf(InsufficientFundsError);

    const final = (await wallets.findById(wallet.id))!;
    expect(final.balance.toJSON().amount).toBe('20.00');
    expect(final.version).toBe(2);
  });

  test('wallets diferentes não se bloqueiam', async () => {
    const [a, b] = [await storedWallet(), await storedWallet()];
    const gate = Promise.withResolvers<void>();

    const holdingA = debitHolding(a.id, '10.00', gate.promise);
    await holdingA.observedBalance;
    await debitHolding(b.id, '10.00').done; // conclui com o lock de A ainda preso

    gate.resolve();
    await holdingA.done;
    expect((await wallets.findById(b.id))!.balance.toJSON().amount).toBe('90.00');
  });

  test('fora de transação a leitura para alteração falha', async () => {
    const wallet = await storedWallet();
    await expect(wallets.findByIdForUpdate(wallet.id)).rejects.toThrow(/transaction/i);
  });
});

describe('claim da outbox', () => {
  const T = Date.parse('2026-07-29T15:00:00.000Z');
  const at = (seconds: number) => new Date(T + seconds * 1000);

  // as outras suítes deste arquivo deixam pendências; cada teste parte de uma outbox sem nenhuma
  beforeEach(() => sql(orm, 'update outbox_messages set published_at = now() where published_at is null'));

  async function pending(occurredAt: Date, state: { nextAttemptAt?: Date; publishedAt?: Date } = {}): Promise<string> {
    const id = uuid();
    await outbox.add(
      OutboxMessage.rehydrate({ id, aggregateId: uuid(), eventType: 'TestEvent', payload: {}, occurredAt, attempts: 0, ...state }),
    );
    return id;
  }
  const claim = (now: Date, limit: number) => runner.run(async () => (await outbox.claimDue(now, limit)).map((m) => m.id));

  test('devolve só pendentes vencidas: novas primeiro, depois por próxima tentativa e ocorrência', async () => {
    const retryLate = await pending(at(0), { nextAttemptAt: at(50) });
    const retryEarly = await pending(at(1), { nextAttemptAt: at(40) });
    const newer = await pending(at(3));
    const older = await pending(at(2));
    await pending(at(0), { nextAttemptAt: at(61) }); // ainda em backoff
    await pending(at(0), { publishedAt: at(1) }); // já publicada

    expect(await claim(at(60), 10)).toEqual([older, newer, retryEarly, retryLate]);
  });

  test('próxima tentativa igual ao instante atual já está vencida', async () => {
    const id = await pending(at(0), { nextAttemptAt: at(60) });
    expect(await claim(at(60), 10)).toEqual([id]);
  });

  test('respeita o limite', async () => {
    const first = await pending(at(0));
    await pending(at(1));
    expect(await claim(at(60), 1)).toEqual([first]);
  });

  test('segunda transação recebe outras linhas sem esperar a primeira', async () => {
    const ids = [await pending(at(0)), await pending(at(1)), await pending(at(2))];
    const gate = Promise.withResolvers<void>();
    const firstClaimed = Promise.withResolvers<string[]>();

    const first = runner.run(async () => {
      firstClaimed.resolve((await outbox.claimDue(at(60), 2)).map((m) => m.id));
      await gate.promise; // segura os locks
    });
    expect(await firstClaimed.promise).toEqual(ids.slice(0, 2));

    // conclui com os locks da primeira ainda presos: SKIP LOCKED, não espera
    expect(await claim(at(60), 10)).toEqual(ids.slice(2));

    gate.resolve();
    await first;
    // sem commit de alteração, as linhas da primeira voltam a estar disponíveis
    expect(await claim(at(60), 10)).toEqual(ids);
  });

  test('fora de transação o claim falha', async () => {
    await expect(outbox.claimDue(at(60), 10)).rejects.toThrow(/transaction/i);
  });
});

describe('persistência atômica', () => {
  async function exists({ wallet, tx, message }: ReturnType<typeof opening>) {
    return {
      wallet: (await wallets.findById(wallet.id)) !== undefined,
      tx: (await transactions.findById(tx.id)) !== undefined,
      entries: (await ledger.listByWallet(wallet.id, { limit: 10 })).entries.length,
      outbox: (await outbox.findById(message.id)) !== undefined,
    };
  }
  async function writeAll({ wallet, tx, entry, message }: ReturnType<typeof opening>) {
    await wallets.add(wallet);
    await transactions.add(tx);
    await ledger.append(entry);
    await outbox.add(message);
  }

  test('commit confirma wallet, transação, lançamento e outbox juntos', async () => {
    const data = opening();
    await runner.run(() => writeAll(data));
    expect(await exists(data)).toEqual({ wallet: true, tx: true, entries: 1, outbox: true });
  });

  test('erro da aplicação desfaz tudo e é propagado', async () => {
    const data = opening();
    const boom = new Error('boom');
    const attempt = runner.run(async () => {
      await writeAll(data);
      throw boom;
    });
    await expect(attempt).rejects.toBe(boom);
    expect(await exists(data)).toEqual({ wallet: false, tx: false, entries: 0, outbox: false });
  });

  test('violação de constraint na última gravação desfaz as anteriores', async () => {
    const data = opening();
    const attempt = runner.run(async () => {
      await writeAll(data);
      await ledger.append(data.entry); // uq_ledger_transaction_wallet (colide na PK antes)
    });
    await expect(attempt).rejects.toBeInstanceOf(UniqueViolationError);
    expect(await exists(data)).toEqual({ wallet: false, tx: false, entries: 0, outbox: false });
  });

  // O consumidor SQS depende disto: a transação do use case roda dentro da que grava a inbox.
  describe('run dentro de run participa da transação externa', () => {
    const inboxMessage = () =>
      InboxMessage.receive({ messageId: uuid(), consumerName: 'nested', payloadHash: 'h', receivedAt: now() });

    test('externa falha depois de a interna concluir: nada da interna existe', async () => {
      const data = opening();
      const boom = new Error('boom');
      const attempt = runner.run(async () => {
        await runner.run(() => writeAll(data));
        throw boom;
      });
      await expect(attempt).rejects.toBe(boom);
      expect(await exists(data)).toEqual({ wallet: false, tx: false, entries: 0, outbox: false });
    });

    test('externa confirma: gravações das duas existem', async () => {
      const data = opening();
      const message = inboxMessage();
      await runner.run(async () => {
        await runner.run(() => writeAll(data));
        await inbox.add(message);
      });
      expect(await exists(data)).toEqual({ wallet: true, tx: true, entries: 1, outbox: true });
      expect(await inbox.find(message.consumerName, message.messageId)).toBeDefined();
    });

    test('interna falha por unicidade: só ela é desfeita e a externa relê e confirma', async () => {
      const existing = await storedWallet();
      const data = opening();
      const message = inboxMessage();

      await runner.run(async () => {
        await inbox.add(message);
        const inner = runner.run(async () => {
          await writeAll(data);
          await wallets.add(existing); // PK repetida
        });
        await expect(inner).rejects.toBeInstanceOf(UniqueViolationError);
        // a transação externa continua utilizável (sem "current transaction is aborted")
        expect(await runner.run(() => wallets.findById(existing.id))).toBeDefined();
      });

      expect(await exists(data)).toEqual({ wallet: false, tx: false, entries: 0, outbox: false });
      expect(await inbox.find(message.consumerName, message.messageId)).toBeDefined();
    });
  });
});

describe('paginação estável do ledger', () => {
  test('páginas seguem a ordem de gravação, sem repetir nem pular, mesmo com lançamento novo no meio', async () => {
    const wallet = await storedWallet(brl('0.00'));
    const ids: string[] = [];
    const credit = async () => {
      const tx = newTx(wallet, { kind: Kind.Win, money: brl('1.00') });
      await transactions.add(tx);
      const entry = wallet.credit(tx.money, movement(tx.id));
      await ledger.append(entry);
      ids.push(entry.id);
    };
    for (let i = 0; i < 5; i++) await credit();

    const page1 = await ledger.listByWallet(wallet.id, { limit: 2 });
    expect(page1.entries.map((e) => e.id)).toEqual(ids.slice(0, 2));

    await credit(); // sexto lançamento, gravado entre as páginas

    const page2 = await ledger.listByWallet(wallet.id, { after: page1.nextCursor, limit: 2 });
    expect(page2.entries.map((e) => e.id)).toEqual(ids.slice(2, 4));

    const page3 = await ledger.listByWallet(wallet.id, { after: page2.nextCursor, limit: 2 });
    expect(page3.entries.map((e) => e.id)).toEqual(ids.slice(4, 6));
    expect(page3.nextCursor).toBeUndefined();
  });
});

describe('pendentes de referência', () => {
  const T = Date.parse('2026-07-29T15:00:00.000Z');
  const at = (seconds: number) => new Date(T + seconds * 1000);
  const FAR = new Date('2100-01-01T00:00:00.000Z');

  // as outras suítes deste arquivo deixam pendentes; cada teste parte de nenhuma vencida
  beforeEach(() => sql(orm, `update wager_transactions set next_reference_attempt_at = ? where status = 'PENDING_REFERENCE'`, [FAR]));

  async function pendingRefund(
    wallet: Wallet,
    state: { nextReferenceAttemptAt?: Date; referenceAttempts?: number } = {},
    overrides: Parameters<typeof txProps>[0] = {},
  ): Promise<WagerTransaction> {
    const props = txProps({
      id: uuid(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: uuid(),
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ref-x',
      createdAt: now(),
      ...overrides,
    });
    const tx = WagerTransaction.rehydrate({ ...props, status: Status.PendingReference, ...state });
    await transactions.add(tx);
    return tx;
  }
  const claim = (id: string, now: Date) => runner.run(() => transactions.claimPendingReference(id, now));

  test('round-trip de tentativas e próxima tentativa', async () => {
    const wallet = await storedWallet();
    const tx = await pendingRefund(wallet);
    expect(await transactions.findById(tx.id)).toEqual(tx);

    tx.scheduleReferenceRetry(at(0), at(900));
    await transactions.savePendingReference(tx);

    const read = (await transactions.findById(tx.id))!;
    expect(read).toEqual(tx);
    expect([read.referenceAttempts, read.nextReferenceAttemptAt]).toEqual([1, at(1)]);
  });

  test('seleção: só pendentes vencidas, nunca tentadas primeiro, depois por vencimento', async () => {
    const wallet = await storedWallet();
    const late = await pendingRefund(wallet, { nextReferenceAttemptAt: at(60) }); // igual ao instante: vencida
    const early = await pendingRefund(wallet, { nextReferenceAttemptAt: at(40) });
    const never = await pendingRefund(wallet);
    await pendingRefund(wallet, { nextReferenceAttemptAt: at(61) }); // em backoff
    const processed = newTx(wallet);
    await transactions.add(processed);
    processed.markProcessed(undefined, brl('75.00'), now());
    await transactions.save(processed);

    expect(await transactions.findDuePendingReferences(at(60), 10)).toEqual(
      [never, early, late].map((tx) => ({ id: tx.id, walletId: wallet.id })),
    );
  });

  test('seleção respeita o limite', async () => {
    const wallet = await storedWallet();
    for (let i = 0; i < 3; i++) await pendingRefund(wallet, { nextReferenceAttemptAt: at(i) });
    expect(await transactions.findDuePendingReferences(at(60), 2)).toHaveLength(2);
  });

  test('claim devolve a pendente vencida com tentativas e próxima tentativa', async () => {
    const wallet = await storedWallet();
    const tx = await pendingRefund(wallet, { nextReferenceAttemptAt: at(10), referenceAttempts: 4 });
    expect(await claim(tx.id, at(60))).toEqual(tx);
  });

  test('claim não devolve transação terminal nem reagendada para o futuro', async () => {
    const wallet = await storedWallet();
    const inBackoff = await pendingRefund(wallet, { nextReferenceAttemptAt: at(61) });
    const resolved = await pendingRefund(wallet);
    resolved.reject(FailureCode.ReferenceNotFound, brl('100.00'), now());
    await transactions.savePendingReference(resolved);

    expect(await claim(inBackoff.id, at(60))).toBeUndefined();
    expect(await claim(resolved.id, at(60))).toBeUndefined();
    expect(await claim(uuid(), at(60))).toBeUndefined();
  });

  test('claim de linha travada por outra transação devolve nada sem esperar', async () => {
    const wallet = await storedWallet();
    const tx = await pendingRefund(wallet);
    const gate = Promise.withResolvers<void>();
    const held = Promise.withResolvers<boolean>();

    const first = runner.run(async () => {
      held.resolve((await transactions.claimPendingReference(tx.id, at(60))) !== undefined);
      await gate.promise; // segura o lock da linha
    });
    expect(await held.promise).toBe(true);

    const started = Date.now();
    expect(await claim(tx.id, at(60))).toBeUndefined(); // SKIP LOCKED
    expect(Date.now() - started).toBeLessThan(1000);

    gate.resolve();
    await first;
    expect(await claim(tx.id, at(60))).toEqual(tx);
  });

  test('fora de transação o claim falha', async () => {
    const wallet = await storedWallet();
    const tx = await pendingRefund(wallet);
    await expect(transactions.claimPendingReference(tx.id, at(60))).rejects.toThrow(/transaction/i);
  });

  test('gravação condicionada: linha que já não está PENDING_REFERENCE não é alterada', async () => {
    const wallet = await storedWallet();
    const tx = await pendingRefund(wallet);
    const stale = (await transactions.findById(tx.id))!; // cópia de outro worker
    tx.reject(FailureCode.ReferenceNotFound, brl('100.00'), now());
    await transactions.savePendingReference(tx);

    stale.reject(FailureCode.ReferenceMismatch, brl('1.00'), now());
    await expect(transactions.savePendingReference(stale)).rejects.toThrow(/esperava atualizar 1 linha, atualizou 0/);

    expect(await transactions.findById(tx.id)).toEqual(tx);
  });

  test('antecipação: só as pendentes do provider que aguardam aquela referência, sem mexer nas tentativas', async () => {
    const wallet = await storedWallet();
    const backoff = { nextReferenceAttemptAt: at(500), referenceAttempts: 3 };
    const target = await pendingRefund(wallet, backoff);
    const otherProvider = await pendingRefund(wallet, backoff, { providerId: 'provider-b' });
    const otherReference = await pendingRefund(wallet, backoff, { referenceExternalTransactionId: 'ref-y' });
    const terminal = await pendingRefund(wallet, backoff);
    terminal.reject(FailureCode.ReferenceNotFound, brl('100.00'), now());
    await transactions.savePendingReference(terminal);

    await transactions.wakePendingReferencesOf('provider-a', 'ref-x', at(10));

    const read = async (tx: WagerTransaction) => {
      const found = (await transactions.findById(tx.id))!;
      return [found.nextReferenceAttemptAt, found.referenceAttempts];
    };
    expect(await read(target)).toEqual([at(10), 3]);
    expect(await read(otherProvider)).toEqual([at(500), 3]);
    expect(await read(otherReference)).toEqual([at(500), 3]);
    expect(await read(terminal)).toEqual([at(500), 3]);
  });
});
