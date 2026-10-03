import { afterAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration } from '@mikro-orm/migrations';
import { loadConfig } from '../src/config';
import { ormOptions } from '../src/mikro-orm.config';
import { Migration20261003120000_persistence } from '../src/migrations/Migration20261003120000_persistence';
import { CHECK, expectViolation, insertWallet, sql } from './persistence/helpers';

const HISTORY_TABLE = 'mikro_orm_migrations';
const DOMAIN_TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];
const options = { ...ormOptions(loadConfig()), logger: () => {} };
const orm = await MikroORM.init(options);

afterAll(() => orm.close());

async function publicTables(): Promise<string[]> {
  const rows = await sql<{ table_name: string }>(
    orm,
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  return rows.map((row) => row.table_name).sort();
}

async function publicFunctions(): Promise<string[]> {
  const rows = await sql<{ proname: string }>(
    orm,
    "select proname from pg_proc where pronamespace = 'public'::regnamespace",
  );
  return rows.map((row) => row.proname);
}

test('up em banco vazio cria o schema de domínio e reexecutar é no-op', async () => {
  await sql(orm, 'drop schema public cascade');
  await sql(orm, 'create schema public');
  expect(await publicTables()).toEqual([]);

  await orm.getMigrator().up();
  expect(await publicTables()).toEqual([...DOMAIN_TABLES, HISTORY_TABLE].sort());

  expect(await orm.getMigrator().up()).toEqual([]);
});

test('down remove todo o schema de domínio e up o recria com as constraints', async () => {
  await orm.getMigrator().down({ to: 0 });
  expect(await publicTables()).toEqual([HISTORY_TABLE]);
  expect(await publicFunctions()).toEqual([]);

  await orm.getMigrator().up();
  expect(await publicTables()).toEqual([...DOMAIN_TABLES, HISTORY_TABLE].sort());
  expect(await publicFunctions()).toEqual(['forbid_ledger_mutation']);
  await expectViolation(insertWallet(orm, { balance: '-1.00' }), CHECK, 'ck_wallets_balance_non_negative');
});

test('migration é aplicada e revertida, saindo do histórico', async () => {
  class MigrationProbe extends Migration {
    override async up() {
      this.addSql('create table _migration_probe (id int primary key)');
    }
    override async down() {
      this.addSql('drop table _migration_probe');
    }
  }
  const probeOrm = await MikroORM.init({
    ...options,
    migrations: {
      ...options.migrations,
      migrationsList: [
        { name: 'Migration20261003120000_persistence', class: Migration20261003120000_persistence },
        { name: 'MigrationProbe', class: MigrationProbe },
      ],
    },
  });
  try {
    const migrator = probeOrm.getMigrator();

    await migrator.up();
    expect(await publicTables()).toContain('_migration_probe');
    expect((await migrator.getExecutedMigrations()).map((m) => m.name)).toContain('MigrationProbe');

    await migrator.down();
    expect(await publicTables()).not.toContain('_migration_probe');
    expect((await migrator.getExecutedMigrations()).map((m) => m.name)).not.toContain('MigrationProbe');
    // só a sonda saiu: o schema de domínio continua aplicado para os próximos arquivos
    expect(await publicTables()).toContain('wallets');
  } finally {
    await probeOrm.close();
  }
});
