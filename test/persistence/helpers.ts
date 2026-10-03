import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config';
import { ormOptions } from '../../src/mikro-orm.config';

export const UNIQUE = '23505';
export const CHECK = '23514';
export const FOREIGN_KEY = '23503';

export const uuid = () => Bun.randomUUIDv7();

export function initOrm(): Promise<MikroORM> {
  return MikroORM.init({ ...ormOptions(loadConfig()), logger: () => {} });
}

type Row = Record<string, unknown>;

export function sql<T = Row>(orm: MikroORM, text: string, params: unknown[] = []): Promise<T[]> {
  return orm.em.getDriver().getConnection().execute(text, params);
}

/** Schema novo a cada arquivo: TRUNCATE não é opção, o ledger o bloqueia. */
export async function resetSchema(orm: MikroORM): Promise<void> {
  await sql(orm, 'drop schema public cascade');
  await sql(orm, 'create schema public');
  await orm.getMigrator().up();
}

async function insert(orm: MikroORM, table: string, row: Row): Promise<Row> {
  const cols = Object.keys(row);
  const [inserted] = await sql(
    orm,
    `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')}) returning *`,
    Object.values(row),
  );
  return inserted!;
}

export const PROCESSED = {
  status: 'PROCESSED',
  processed_at: new Date(),
  completed_at: new Date(),
  result_balance_amount: '90.00',
  result_balance_currency: 'BRL',
};

export function insertWallet(orm: MikroORM, overrides: Row = {}): Promise<Row> {
  const now = new Date();
  return insert(orm, 'wallets', {
    id: uuid(),
    player_id: uuid(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

export function insertTx(orm: MikroORM, walletId: unknown, overrides: Row = {}): Promise<Row> {
  return insert(orm, 'wager_transactions', {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: uuid(),
    idempotency_key: uuid(),
    payload_hash: 'hash',
    wallet_id: walletId,
    player_id: 'player',
    round_id: 'round',
    game_id: 'game',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: new Date(),
    ...overrides,
  });
}

export function insertEntry(orm: MikroORM, walletId: unknown, transactionId: unknown, overrides: Row = {}): Promise<Row> {
  return insert(orm, 'wallet_ledger_entries', {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: new Date(),
    ...overrides,
  });
}

/** Afirma SQLSTATE e nome da constraint: sem o nome, o teste passaria colidindo com a regra errada. */
export async function expectViolation(attempt: Promise<unknown>, code: string, constraint: string): Promise<void> {
  const error = await attempt.then(
    () => undefined,
    (e: { code?: string; constraint?: string }) => e,
  );
  expect({ code: error?.code, constraint: error?.constraint }).toEqual({ code, constraint });
}
