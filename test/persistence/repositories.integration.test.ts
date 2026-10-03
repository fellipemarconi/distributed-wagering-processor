import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { initOrm, resetSchema, uuid } from './helpers';

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
