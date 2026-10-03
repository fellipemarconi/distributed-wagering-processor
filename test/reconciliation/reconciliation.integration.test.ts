import { afterAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { balanceOf, boot, countRows, expectLedgerInvariant, openWallet, payload, submitted, uuid } from '../application/helpers';
import { holdingLock } from '../consumer/helpers';
import { metric } from '../observability/helpers';
import { sql } from '../persistence/helpers';

// Ponta a ponta: AppModule real + fetch; divergências induzidas por SQL direto, como um operador faria.
const app = await boot();
const url = await app.getUrl();
const db: MikroORM = app.get(MikroORM);
afterAll(() => app.close());

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const DIVERGENCES = 'wagering_reconciliation_divergences_total';

async function reconcile(walletId: string) {
  const res = await fetch(`${url}/wallets/${walletId}/reconciliation`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Wallet com abertura + BET, WIN, REFUND de outra BET e ROLLBACK do WIN: 6 lançamentos, saldo 100.00. */
async function playedWallet() {
  const w = await openWallet(app, '100.00');
  const bet = payload(w, { money: brl('30.00') });
  const win = payload(w, { kind: 'WIN', money: brl('45.50') });
  const refunded = payload(w, { money: brl('12.34') });
  await submitted(app, bet); // 70.00
  await submitted(app, win); // 115.50
  await submitted(app, refunded); // 103.16
  await submitted(app, payload(w, { kind: 'REFUND', money: brl('12.34'), referenceExternalTransactionId: refunded.externalTransactionId })); // 115.50
  await submitted(app, payload(w, { kind: 'ROLLBACK', money: brl('45.50'), referenceExternalTransactionId: win.externalTransactionId })); // 70.00
  await submitted(app, payload(w, { kind: 'LOSS', money: brl('5.00') })); // sem lançamento
  return w;
}

/** Estado que a reconciliação não pode alterar. */
const snapshotOf = async (walletId: string) => ({
  wallet: await sql(db, 'select balance, version, updated_at from wallets where id = ?', [walletId]),
  ledger: await sql(db, 'select id, amount, balance_before, balance_after from wallet_ledger_entries where wallet_id = ? order by seq', [walletId]),
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente após BET, WIN, REFUND e ROLLBACK, no formato do enunciado', async () => {
    const w = await playedWallet();
    const divergences = await metric(app, DIVERGENCES);

    const res = await reconcile(w.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: brl('70.00'),
      calculatedBalance: brl('70.00'),
      difference: brl('0.00'),
      consistent: true,
      chainIntact: true,
      checkedEntries: 6,
    });
    expect(await metric(app, DIVERGENCES)).toBe(divergences);
    await expectLedgerInvariant(app, w.id);
  });

  test('wallet sem lançamentos: tudo zero e consistente', async () => {
    const w = await openWallet(app, '0.00');

    expect((await reconcile(w.id)).body).toEqual({
      walletId: w.id,
      storedBalance: brl('0.00'),
      calculatedBalance: brl('0.00'),
      difference: brl('0.00'),
      consistent: true,
      chainIntact: true,
      checkedEntries: 0,
    });
  });

  test('404 wallet inexistente; 400 id malformado', async () => {
    const missing = await reconcile(uuid());
    const malformed = await reconcile('not-a-uuid');

    expect([missing.status, missing.body]).toEqual([404, { error: { code: 'WALLET_NOT_FOUND', message: expect.any(String) } }]);
    expect([malformed.status, malformed.body.error.code]).toEqual([400, 'INVALID_PAYLOAD']);
  });

  test('ledger com mais de uma página (1201 lançamentos) é percorrido inteiro', async () => {
    const w = await openWallet(app, '10.00');
    await db.em.fork().transactional(async (em) => {
      await em.execute(
        `with tx as (
           insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
             player_id, round_id, game_id, kind, amount, currency, status, processed_at, completed_at,
             result_balance_amount, result_balance_currency, created_at)
           select gen_random_uuid(), 'seed', gen_random_uuid()::text, gen_random_uuid()::text, 'h', ?, 'p', 'r', 'g', 'WIN', 1, 'BRL',
             'PROCESSED', now(), now(), 10 + n, 'BRL', now() from generate_series(1, 1200) n
           returning id, result_balance_amount as after)
         insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         select gen_random_uuid(), ?, id, 'CREDIT', 1, 'BRL', after - 1, after, now() from tx order by after`,
        [w.id, w.id],
      );
      await em.execute('update wallets set balance = 1210, version = 1201 where id = ?', [w.id]);
    });

    const res = await reconcile(w.id);

    expect(res.body).toMatchObject({ calculatedBalance: brl('1210.00'), consistent: true, chainIntact: true, checkedEntries: 1201 });
  });
});

describe('divergência é sinalizada e nunca corrigida', () => {
  test.each([
    ['acima', '+ 10', '80.00', '10.00'],
    ['abaixo', '- 10', '60.00', '-10.00'],
  ])('saldo armazenado %s do ledger', async (_label, change, stored, difference) => {
    const w = await playedWallet();
    await sql(db, `update wallets set balance = balance ${change} where id = ?`, [w.id]);
    const before = await snapshotOf(w.id);
    const divergences = await metric(app, DIVERGENCES);

    const first = await reconcile(w.id);
    const second = await reconcile(w.id);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      walletId: w.id,
      storedBalance: brl(stored),
      calculatedBalance: brl('70.00'),
      difference: brl(difference),
      consistent: false,
      chainIntact: false, // o último lançamento não termina no saldo armazenado
      checkedEntries: 6,
    });
    expect(second.body).toEqual(first.body);
    expect(await metric(app, DIVERGENCES)).toBe(divergences + 2); // uma por reconciliação divergente
    // nada corrigido: saldo, versão e lançamentos exatamente como estavam
    expect(await snapshotOf(w.id)).toEqual(before);
    expect(await balanceOf(app, w.id)).toBe(stored);
  });
});

describe('continuidade da corrente', () => {
  /** Adultera um lançamento por SQL: o trigger de imutabilidade é desligado só dentro da transação. */
  async function tamper(walletId: string, position: number, shift: string) {
    await db.em.fork().transactional(async (em) => {
      await em.execute('alter table wallet_ledger_entries disable trigger trg_ledger_no_update_delete');
      // os dois saldos deslocados juntos: a aritmética do lançamento continua válida, a soma não muda
      await em.execute(
        `update wallet_ledger_entries set balance_before = balance_before + ${shift}, balance_after = balance_after + ${shift}
          where id = (select id from wallet_ledger_entries where wallet_id = ? order by seq offset ? limit 1)`,
        [walletId, position],
      );
      await em.execute('alter table wallet_ledger_entries enable trigger trg_ledger_no_update_delete');
    });
  }

  test('elo intermediário quebrado com a soma preservada: difference 0.00 e consistent false', async () => {
    const w = await playedWallet();
    await tamper(w.id, 2, '3'); // terceiro lançamento
    const divergences = await metric(app, DIVERGENCES);

    const res = await reconcile(w.id);

    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: brl('70.00'),
      calculatedBalance: brl('70.00'),
      difference: brl('0.00'),
      consistent: false,
      chainIntact: false,
      checkedEntries: 6,
    });
    expect(await metric(app, DIVERGENCES)).toBe(divergences + 1);
    expect(await balanceOf(app, w.id)).toBe('70.00');
  });

  test('primeiro lançamento que não parte de zero quebra a corrente', async () => {
    const w = await openWallet(app, '100.00');
    await tamper(w.id, 0, '5'); // abertura: 5.00 → 105.00
    await sql(db, 'update wallets set balance = 105 where id = ?', [w.id]); // o fim da corrente bate; só o início não

    expect((await reconcile(w.id)).body).toMatchObject({
      storedBalance: brl('105.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('5.00'),
      chainIntact: false,
      consistent: false,
    });
  });

  test('o trigger de imutabilidade continua ativo depois dos testes de adulteração', async () => {
    const w = await openWallet(app, '100.00');
    await expect(sql(db, 'update wallet_ledger_entries set amount = 1 where wallet_id = ?', [w.id])).rejects.toThrow(/append-only/);
  });
});

describe('leitura consistente e sem bloqueio', () => {
  test('reconciliações concorrentes com 60 apostas na mesma wallet: nenhum falso positivo', async () => {
    const BETS = 60;
    const w = await openWallet(app, '1000.00');
    let betting = true;
    const reports: Record<string, any>[] = [];

    const reconciling = (async () => {
      while (betting) reports.push((await reconcile(w.id)).body);
    })();
    const bets = await Promise.all(Array.from({ length: BETS }, () => submitted(app, payload(w, { money: brl('10.00') }))));
    betting = false;
    await reconciling;
    reports.push((await reconcile(w.id)).body);

    expect(bets.every((bet) => bet.status === 'PROCESSED')).toBe(true);
    expect(reports.length).toBeGreaterThan(5);
    expect(reports.filter((report) => !report.consistent)).toEqual([]);
    // as reconciliações enxergaram estados diferentes, cada um deles íntegro
    expect(new Set(reports.map((report) => report.checkedEntries)).size).toBeGreaterThan(1);
    expect(reports.at(-1)).toMatchObject({ storedBalance: brl('400.00'), checkedEntries: BETS + 1 });
    expect(await countRows(app, 'wallet_ledger_entries', 'wallet_id = ?', [w.id])).toBe(BETS + 1);
    await expectLedgerInvariant(app, w.id);
  }, 30_000);

  test('wallet travada por outra transação: responde sem esperar, com o estado confirmado', async () => {
    const w = await openWallet(app, '100.00');

    const { res, elapsedMs } = await holdingLock(app, w.id, async () => {
      const started = Date.now();
      return { res: await reconcile(w.id), elapsedMs: Date.now() - started };
    });

    expect(res.body).toMatchObject({ storedBalance: brl('100.00'), consistent: true });
    expect(elapsedMs).toBeLessThan(1000); // dbLockTimeoutMs é 5000: não esperou o lock
  });
});
