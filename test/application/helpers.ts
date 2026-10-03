import { expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { CreateWallet } from '../../src/application/create-wallet';
import { ProcessWagerTransaction, type ProcessWagerResult } from '../../src/application/process-wager-transaction';
import { loadConfig, type Config } from '../../src/config';
import type { WagerTransaction } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { sql, uuid } from '../persistence/helpers';

export { uuid };

/** AppModule real (Postgres e SQS reais) em uma porta livre. `customize` troca providers para injetar falha. */
export async function boot(
  overrides: Partial<Config> = {},
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot({ ...loadConfig(), ...overrides })] });
  const app = (await customize(builder).compile()).createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return app;
}

export const ctx = () => ({ correlationId: uuid() });

export async function openWallet(app: INestApplication, amount = '100.00', currency = 'BRL'): Promise<Wallet> {
  const result = await app
    .get(CreateWallet)
    .execute({ playerId: uuid(), initialBalance: { amount, currency } }, ctx());
  if (result.outcome !== 'created') throw new Error('wallet de teste não foi criada');
  return result.wallet;
}

type Target = Pick<Wallet, 'id' | 'playerId'>;

/** Payload de submissão; ids únicos por chamada e chave no formato recomendado pelo enunciado. */
export function payload(wallet: Target, overrides: Record<string, unknown> = {}) {
  const base = {
    providerId: 'provider-a',
    externalTransactionId: uuid(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
  return { idempotencyKey: `${base.providerId}:${base.externalTransactionId}`, ...base };
}

// status/failureCode como string: os testes afirmam o valor serializado, que é o contrato com o provedor
type Tx = Omit<WagerTransaction, 'status' | 'failureCode'> & { status: string; failureCode?: string };
type Result = Exclude<ProcessWagerResult, { transaction: unknown }> | { outcome: 'processed' | 'rejected' | 'pending' | 'replay'; transaction: Tx };

export const submit = (app: INestApplication, input: unknown): Promise<Result> =>
  app.get(ProcessWagerTransaction).execute(input, ctx()) as Promise<Result>;

/** Submete e exige que tenha virado uma transação gravada (não conflito nem not-found). */
export async function submitted(app: INestApplication, input: unknown): Promise<Tx> {
  const result = await submit(app, input);
  if (!('transaction' in result)) throw new Error(`esperava transação, veio ${result.outcome}`);
  return result.transaction;
}

export const balanceOf = async (app: INestApplication, walletId: string): Promise<string> =>
  (await sql<{ balance: string }>(app.get(MikroORM), 'select balance from wallets where id = ?', [walletId]))[0]!.balance;

export const ledgerOf = (app: INestApplication, walletId: string) =>
  sql<{ direction: string; amount: string; balance_before: string; balance_after: string; transaction_id: string }>(
    app.get(MikroORM),
    'select direction, amount, balance_before, balance_after, transaction_id from wallet_ledger_entries where wallet_id = ? order by seq',
    [walletId],
  );

/** Tipos de evento na outbox causados por uma transação (os dela e o WalletBalanceChanged da wallet). */
export const eventsOf = async (app: INestApplication, transactionId: string): Promise<string[]> =>
  (
    await sql<{ event_type: string }>(
      app.get(MikroORM),
      `select event_type from outbox_messages
       where aggregate_id = ? or payload->'data'->>'transactionId' = ? order by event_type`,
      [transactionId, transactionId],
    )
  ).map((row) => row.event_type);

export const countRows = async (app: INestApplication, table: string, where: string, params: unknown[]) =>
  Number((await sql<{ n: string }>(app.get(MikroORM), `select count(*) as n from ${table} where ${where}`, params))[0]!.n);

/** Invariante final de todo teste: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectLedgerInvariant(app: INestApplication, walletId: string): Promise<void> {
  const [row] = await sql<{ balance: string; rebuilt: string; last: string | null }>(
    app.get(MikroORM),
    `select w.balance,
            (select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(19,2)
               from wallet_ledger_entries where wallet_id = w.id) as rebuilt,
            (select balance_after from wallet_ledger_entries where wallet_id = w.id order by seq desc limit 1) as last
       from wallets w where w.id = ?`,
    [walletId],
  );
  expect(row!.rebuilt).toBe(row!.balance);
  if (row!.last !== null) expect(row!.last).toBe(row!.balance);
}
