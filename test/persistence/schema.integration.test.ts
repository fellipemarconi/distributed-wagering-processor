import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CHECK,
  FOREIGN_KEY,
  PROCESSED,
  UNIQUE,
  expectViolation,
  initOrm,
  insertEntry,
  insertTx,
  insertWallet,
  resetSchema,
  sql,
  uuid,
} from './helpers';

const orm = await initOrm();
beforeAll(() => resetSchema(orm));
afterAll(() => orm.close());

const REJECTED = {
  status: 'REJECTED',
  failure_code: 'INSUFFICIENT_FUNDS',
  completed_at: new Date(),
  result_balance_amount: '100.00',
  result_balance_currency: 'BRL',
};

describe('wallets', () => {
  test('segunda wallet para o mesmo jogador e moeda é recusada; outra moeda é aceita', async () => {
    const wallet = await insertWallet(orm);
    await expectViolation(
      insertWallet(orm, { player_id: wallet.player_id }),
      UNIQUE,
      'uq_wallets_player_currency',
    );
    await insertWallet(orm, { player_id: wallet.player_id, currency: 'USD' });
  });

  test('saldo negativo é recusado em INSERT e UPDATE', async () => {
    await expectViolation(insertWallet(orm, { balance: '-0.01' }), CHECK, 'ck_wallets_balance_non_negative');
    const wallet = await insertWallet(orm);
    await expectViolation(
      sql(orm, 'update wallets set balance = balance - 100.01 where id = ?', [wallet.id]),
      CHECK,
      'ck_wallets_balance_non_negative',
    );
  });

  test('versão menor que 1 é recusada', async () => {
    await expectViolation(insertWallet(orm, { version: 0 }), CHECK, 'ck_wallets_version_positive');
  });

  test.each(['brl', 'BR', 'REAL'])('moeda %s é recusada', async (currency) => {
    await expectViolation(insertWallet(orm, { currency }), CHECK, 'ck_wallets_currency_iso');
  });
});

describe('wager_transactions: unicidade', () => {
  test('mesmo provedor + id externo é recusado; outro provedor é aceito', async () => {
    const wallet = await insertWallet(orm);
    const tx = await insertTx(orm, wallet.id);
    await expectViolation(
      insertTx(orm, wallet.id, { external_transaction_id: tx.external_transaction_id }),
      UNIQUE,
      'uq_wager_tx_provider_external',
    );
    await insertTx(orm, wallet.id, { provider_id: 'provider-b', external_transaction_id: tx.external_transaction_id });
  });

  test('mesmo provedor + chave de idempotência é recusado; outro provedor é aceito', async () => {
    const wallet = await insertWallet(orm);
    const tx = await insertTx(orm, wallet.id);
    await expectViolation(
      insertTx(orm, wallet.id, { idempotency_key: tx.idempotency_key }),
      UNIQUE,
      'uq_wager_tx_provider_idempotency_key',
    );
    await insertTx(orm, wallet.id, { provider_id: 'provider-b', idempotency_key: tx.idempotency_key });
  });

  test('segunda OPENING para a mesma wallet é recusada', async () => {
    const wallet = await insertWallet(orm);
    await insertTx(orm, wallet.id, { kind: 'OPENING' });
    await expectViolation(insertTx(orm, wallet.id, { kind: 'OPENING' }), UNIQUE, 'uq_wager_tx_opening_per_wallet');
  });
});

describe('wager_transactions: valores e integridade referencial', () => {
  test.each([
    [{ kind: 'BONUS' }, 'ck_wager_tx_kind'],
    [{ status: 'DONE' }, 'ck_wager_tx_status'],
    [{ amount: '-0.01' }, 'ck_wager_tx_amount_non_negative'],
    [{ currency: 'brl' }, 'ck_wager_tx_currency_iso'],
    [{ reference_attempts: -1 }, 'ck_wager_tx_reference_attempts'],
  ])('%o é recusado por %s', async (overrides, constraint) => {
    const wallet = await insertWallet(orm);
    await expectViolation(insertTx(orm, wallet.id, overrides), CHECK, constraint);
  });

  test('wallet inexistente é recusada', async () => {
    await expectViolation(insertTx(orm, uuid()), FOREIGN_KEY, 'fk_wager_tx_wallet');
  });

  test('referência interna inexistente é recusada', async () => {
    const wallet = await insertWallet(orm);
    await expectViolation(
      insertTx(orm, wallet.id, { reference_transaction_id: uuid() }),
      FOREIGN_KEY,
      'fk_wager_tx_reference',
    );
  });
});

describe('wager_transactions: coerência entre estado e campos', () => {
  test.each([
    ['REJECTED sem failure_code', { ...REJECTED, failure_code: null }, 'ck_wager_tx_failure_code'],
    ['FAILED sem failure_code', { status: 'FAILED', completed_at: new Date() }, 'ck_wager_tx_failure_code'],
    ['PENDING com failure_code', { failure_code: 'X' }, 'ck_wager_tx_failure_code'],
    ['PROCESSED com failure_code', { ...PROCESSED, failure_code: 'X' }, 'ck_wager_tx_failure_code'],
    ['PROCESSED sem processed_at', { ...PROCESSED, processed_at: null }, 'ck_wager_tx_processed_at'],
    ['REJECTED com processed_at', { ...REJECTED, processed_at: new Date() }, 'ck_wager_tx_processed_at'],
    ['terminal sem completed_at', { ...PROCESSED, completed_at: null }, 'ck_wager_tx_completed_at'],
    ['PENDING com completed_at', { completed_at: new Date() }, 'ck_wager_tx_completed_at'],
    ['PROCESSED sem saldo resultante', { ...PROCESSED, result_balance_amount: null, result_balance_currency: null }, 'ck_wager_tx_result_balance'],
    ['saldo resultante sem moeda', { ...PROCESSED, result_balance_currency: null }, 'ck_wager_tx_result_balance'],
    ['saldo resultante negativo', { ...PROCESSED, result_balance_amount: '-1.00' }, 'ck_wager_tx_result_balance'],
    ['PENDING com saldo resultante', { result_balance_amount: '1.00', result_balance_currency: 'BRL' }, 'ck_wager_tx_result_balance'],
    ['REFUND sem referência externa', { kind: 'REFUND' }, 'ck_wager_tx_reversal_has_reference'],
    ['ROLLBACK sem referência externa', { kind: 'ROLLBACK' }, 'ck_wager_tx_reversal_has_reference'],
  ])('%s é recusado', async (_name, overrides, constraint) => {
    const wallet = await insertWallet(orm);
    await expectViolation(insertTx(orm, wallet.id, overrides), CHECK, constraint);
  });

  test('UPDATE para REJECTED sem failure_code é recusado', async () => {
    const wallet = await insertWallet(orm);
    const tx = await insertTx(orm, wallet.id);
    await expectViolation(
      sql(orm, "update wager_transactions set status = 'REJECTED', completed_at = now() where id = ?", [tx.id]),
      CHECK,
      'ck_wager_tx_failure_code',
    );
  });

  test('estados válidos são aceitos', async () => {
    const wallet = await insertWallet(orm);
    await insertTx(orm, wallet.id, PROCESSED);
    await insertTx(orm, wallet.id, REJECTED);
    await insertTx(orm, wallet.id, { status: 'FAILED', failure_code: 'INTERNAL_ERROR', completed_at: new Date() });
    await insertTx(orm, wallet.id, { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PENDING_REFERENCE' });
  });
});

describe('wager_transactions: reversão única', () => {
  async function betWithReversals() {
    const wallet = await insertWallet(orm);
    const bet = await insertTx(orm, wallet.id, PROCESSED);
    const reversal = (kind: string, overrides = {}) =>
      insertTx(orm, wallet.id, {
        kind,
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
        ...overrides,
      });
    return { bet, reversal };
  }

  test('ROLLBACK não pode ser processado se já existe REFUND processado da mesma aposta', async () => {
    const { reversal } = await betWithReversals();
    await reversal('REFUND', PROCESSED);
    const rollback = await reversal('ROLLBACK');
    await expectViolation(
      sql(
        orm,
        `update wager_transactions set status = 'PROCESSED', processed_at = now(), completed_at = now(),
           result_balance_amount = 100, result_balance_currency = 'BRL' where id = ?`,
        [rollback.id],
      ),
      UNIQUE,
      'uq_wager_tx_processed_reversal',
    );
  });

  test('reversões não aplicadas não contam', async () => {
    const { reversal } = await betWithReversals();
    await reversal('REFUND', PROCESSED);
    await reversal('REFUND', REJECTED);
    await reversal('ROLLBACK');
  });

  test('reversão processada sem referência resolvida é recusada', async () => {
    const { reversal } = await betWithReversals();
    await expectViolation(
      reversal('REFUND', { ...PROCESSED, reference_transaction_id: null }),
      CHECK,
      'ck_wager_tx_processed_reversal_resolved',
    );
  });
});

describe('wallet_ledger_entries: integridade', () => {
  async function walletAndTx() {
    const wallet = await insertWallet(orm);
    const tx = await insertTx(orm, wallet.id, PROCESSED);
    return { wallet, tx };
  }

  test('segundo lançamento para a mesma transação + wallet é recusado', async () => {
    const { wallet, tx } = await walletAndTx();
    await insertEntry(orm, wallet.id, tx.id);
    await expectViolation(insertEntry(orm, wallet.id, tx.id), UNIQUE, 'uq_ledger_transaction_wallet');
  });

  test('lançamento em wallet que não é a da transação é recusado', async () => {
    const { tx } = await walletAndTx();
    const otherWallet = await insertWallet(orm);
    await expectViolation(insertEntry(orm, otherWallet.id, tx.id), FOREIGN_KEY, 'fk_ledger_transaction');
  });

  test('wallet inexistente é recusada', async () => {
    const { tx } = await walletAndTx();
    // a FK composta também falharia; qualquer uma das duas barra o lançamento órfão
    const error = await insertEntry(orm, uuid(), tx.id).catch((e) => e);
    expect(error.code).toBe(FOREIGN_KEY);
  });

  test.each([
    ['valor zero', { amount: '0.00', balance_after: '100.00' }, 'ck_ledger_amount_positive'],
    ['saldo posterior negativo', { amount: '100.01', balance_after: '-0.01' }, 'ck_ledger_balances_non_negative'],
    ['saldo anterior negativo', { direction: 'CREDIT', balance_before: '-10.00', balance_after: '0.00' }, 'ck_ledger_balances_non_negative'],
    ['direção desconhecida', { direction: 'TRANSFER' }, 'ck_ledger_direction'],
    ['crédito que não fecha', { direction: 'CREDIT', balance_before: '10.00', amount: '5.00', balance_after: '14.99' }, 'ck_ledger_arithmetic'],
    ['débito que não fecha', { direction: 'DEBIT', balance_before: '10.00', amount: '5.00', balance_after: '15.00' }, 'ck_ledger_arithmetic'],
    ['moeda fora do formato', { currency: 'brl' }, 'ck_ledger_currency_iso'],
  ])('%s é recusado', async (_name, overrides, constraint) => {
    const { wallet, tx } = await walletAndTx();
    await expectViolation(insertEntry(orm, wallet.id, tx.id, overrides), CHECK, constraint);
  });

  test('seq é crescente na ordem de gravação e não pode ser informado', async () => {
    const wallet = await insertWallet(orm);
    const seqs: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const tx = await insertTx(orm, wallet.id, PROCESSED);
      seqs.push(BigInt((await insertEntry(orm, wallet.id, tx.id)).seq as string));
    }
    expect(seqs[0]! < seqs[1]! && seqs[1]! < seqs[2]!).toBe(true);

    const tx = await insertTx(orm, wallet.id, PROCESSED);
    const error = await insertEntry(orm, wallet.id, tx.id, { seq: 1 }).catch((e) => e);
    expect(error.code).toBe('428C9'); // generated_always
  });
});

describe('wallet_ledger_entries: imutabilidade', () => {
  const APPEND_ONLY = /append-only/;

  async function entry() {
    const wallet = await insertWallet(orm);
    const tx = await insertTx(orm, wallet.id, PROCESSED);
    return insertEntry(orm, wallet.id, tx.id);
  }
  const reload = async (id: unknown) => (await sql(orm, 'select * from wallet_ledger_entries where id = ?', [id]))[0];

  test('UPDATE é recusado e o lançamento permanece inalterado', async () => {
    const before = await entry();
    await expect(sql(orm, "update wallet_ledger_entries set amount = 1 where id = ?", [before.id])).rejects.toThrow(
      APPEND_ONLY,
    );
    expect(await reload(before.id)).toEqual(before);
  });

  test('DELETE é recusado e o lançamento continua existindo', async () => {
    const before = await entry();
    await expect(sql(orm, 'delete from wallet_ledger_entries where id = ?', [before.id])).rejects.toThrow(APPEND_ONLY);
    expect(await reload(before.id)).toEqual(before);
  });

  test('TRUNCATE é recusado e os lançamentos continuam existindo', async () => {
    const before = await entry();
    await expect(sql(orm, 'truncate wallet_ledger_entries')).rejects.toThrow(APPEND_ONLY);
    expect(await reload(before.id)).toEqual(before);
  });
});

describe('inbox e outbox', () => {
  const inbox = (consumer: string, messageId: string) =>
    sql(
      orm,
      'insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())',
      [consumer, messageId, 'hash'],
    );

  test('mesma mensagem para o mesmo consumidor é recusada; outro consumidor é aceito', async () => {
    const messageId = uuid();
    await inbox('consumer-a', messageId);
    await expectViolation(inbox('consumer-a', messageId), UNIQUE, 'pk_inbox_messages');
    await inbox('consumer-b', messageId);
  });

  test('tentativas negativas na outbox são recusadas', async () => {
    await expectViolation(
      sql(
        orm,
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
         values (?, ?, 'E', '{}', now(), -1)`,
        [uuid(), uuid()],
      ),
      CHECK,
      'ck_outbox_attempts_non_negative',
    );
  });
});

test('índices parciais de apoio aos workers existem com o predicado esperado', async () => {
  const rows = await sql<{ indexname: string; indexdef: string }>(
    orm,
    "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in (?, ?)",
    ['ix_outbox_pending', 'ix_wager_tx_pending_reference_due'],
  );
  const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
  expect(defs.ix_outbox_pending).toMatch(/\(next_attempt_at NULLS FIRST\) WHERE \(published_at IS NULL\)/);
  expect(defs.ix_wager_tx_pending_reference_due).toMatch(
    /\(next_reference_attempt_at NULLS FIRST\) WHERE \(status = 'PENDING_REFERENCE'::text\)/,
  );
});
