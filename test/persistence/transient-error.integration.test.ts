import { afterAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { UniqueViolationError } from '../../src/application/ports';
import { loadConfig } from '../../src/config';
import { isTransientInfraError } from '../../src/infra/persistence/transient-error';
import { ormOptions } from '../../src/mikro-orm.config';
import { insertWallet, sql } from './helpers';

const init = (overrides = {}) => MikroORM.init({ ...ormOptions({ ...loadConfig(), ...overrides }), logger: () => {} });

const orm = await init({ dbLockTimeoutMs: 200 });
afterAll(() => orm.close());

test('lock_timeout configurado vale para as conexões do pool', async () => {
  expect(await sql(orm, 'show lock_timeout')).toEqual([{ lock_timeout: '200ms' }]);
});

test('FOR UPDATE bloqueado além do lock_timeout é falha transitória', async () => {
  const wallet = await insertWallet(orm);
  const lock = 'select id from wallets where id = ? for update';

  const error = await orm.em.transactional(async (holder) => {
    await holder.execute(lock, [wallet.id]);
    return orm.em.fork().transactional((waiter) => waiter.execute(lock, [wallet.id])).catch((e) => e);
  });

  expect(error).toBeInstanceOf(Error);
  expect(isTransientInfraError(error)).toBe(true);
});

test('conexão recusada é falha transitória', async () => {
  // porta 1: conexão recusada de verdade, sem mock
  const closed = await init({ databaseUrl: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test' });
  try {
    const error = await sql(closed, 'select 1').catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isTransientInfraError(error)).toBe(true);
  } finally {
    await closed.close();
  }
});

test('erro de negócio ou de programação não é transitório', () => {
  expect(isTransientInfraError(new UniqueViolationError('uq_wallets_player_currency'))).toBe(false);
  expect(isTransientInfraError(new Error('boom'))).toBe(false);
  expect(isTransientInfraError(undefined)).toBe(false);
});
