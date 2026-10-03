import { afterAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration } from '@mikro-orm/migrations';
import { loadConfig } from '../src/config';
import { ormOptions } from '../src/mikro-orm.config';

const HISTORY_TABLE = 'mikro_orm_migrations';
const options = { ...ormOptions(loadConfig()), logger: () => {} };
const orm = await MikroORM.init(options);

afterAll(() => orm.close());

async function publicTables(): Promise<string[]> {
  const rows: Array<{ table_name: string }> = await orm.em
    .getDriver()
    .getConnection()
    .execute("select table_name from information_schema.tables where table_schema = 'public'");
  return rows.map((row) => row.table_name).sort();
}

test('up em banco vazio cria apenas a tabela de histórico e reexecutar é no-op', async () => {
  await orm.em.getDriver().getConnection().execute(`drop table if exists ${HISTORY_TABLE}`);
  expect(await publicTables()).toEqual([]);

  await orm.getMigrator().up();
  // a fundação não cria tabelas de domínio
  expect(await publicTables()).toEqual([HISTORY_TABLE]);

  expect(await orm.getMigrator().up()).toEqual([]);
  expect(await publicTables()).toEqual([HISTORY_TABLE]);
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
      migrationsList: [{ name: 'MigrationProbe', class: MigrationProbe }],
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
  } finally {
    await probeOrm.close();
  }
});
