import { afterAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Clock } from '../../src/application/ports';
import { AuthGuard } from '../../src/http/auth.guard';
import { boot, countRows, expectLedgerInvariant, payload, uuid } from '../application/helpers';
import { sql } from '../persistence/helpers';

// Ponta a ponta: AppModule real em porta livre + fetch. Os nomes dos testes de status começam pelo
// código HTTP — há pelo menos um para cada linha do mapeamento (ARCHITECTURE.md).
const app = await boot();
const url = await app.getUrl();
afterAll(() => app.close());
const db: MikroORM = app.get(MikroORM);

type Json = Record<string, any>;
interface Reply {
  status: number;
  body: Json;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = url): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00', base = url): Promise<{ id: string; playerId: string }> {
  const res = await call('POST', '/wallets', { playerId: uuid(), initialBalance: brl(amount) }, {}, base);
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

/** Corpo sem a chave (ela vai no header) + a chave, como um provedor enviaria. */
function request(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const { idempotencyKey, ...body } = payload(wallet, overrides);
  return { body, key: idempotencyKey };
}
const post = (req: { body: unknown; key: string }, base = url) =>
  call('POST', '/wagering/transactions', req.body, { 'Idempotency-Key': req.key }, base);

describe('POST /wagering/transactions — status por desfecho', () => {
  test('201 transação aplicada, com o corpo do enunciado', async () => {
    const wallet = await createWallet('1000.00');

    const res = await post(request(wallet));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    await expectLedgerInvariant(app, wallet.id);
  });

  test('200 replay devolve o resultado original com idempotentReplay: true', async () => {
    const wallet = await createWallet('1000.00');
    const req = request(wallet);
    const first = await post(req);
    await post(request(wallet, { money: brl('100.00') })); // saldo muda entre as duas chamadas

    const replay = await post(req);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('975.00'));
    await expectLedgerInvariant(app, wallet.id);
  });

  test('202 PENDING_REFERENCE (REFUND antes da BET), sem balance; replay também 202', async () => {
    const wallet = await createWallet();
    const req = request(wallet, { kind: 'REFUND', referenceExternalTransactionId: uuid() });

    const first = await post(req);
    const replay = await post(req);

    expect(first.status).toBe(202);
    expect(first.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectLedgerInvariant(app, wallet.id);
  });

  test('422 rejeição de negócio com failureCode; replay da rejeição também 422', async () => {
    const wallet = await createWallet('20.00');
    const req = request(wallet, { money: brl('80.00') });

    const first = await post(req);
    const replay = await post(req);

    expect(first.status).toBe(422);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('20.00'),
      idempotentReplay: false,
    });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectLedgerInvariant(app, wallet.id);
  });

  test('400 header Idempotency-Key ausente', async () => {
    const wallet = await createWallet();
    const { body } = request(wallet);

    const res = await call('POST', '/wagering/transactions', body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: expect.any(String) } });
    expect(await countRows(app, 'wager_transactions', 'external_transaction_id = ?', [body.externalTransactionId])).toBe(0);
  });

  test('400 payload inválido: JSON malformado, OPENING e campo ausente', async () => {
    const wallet = await createWallet();
    const invalid = { error: { code: 'INVALID_PAYLOAD', message: expect.any(String) } };

    const malformed = await call('POST', '/wagering/transactions', '{"providerId": ', { 'Idempotency-Key': uuid(), 'content-type': 'application/json' });
    const opening = await post(request(wallet, { kind: 'OPENING' }));
    const missing = await post(request(wallet, { money: undefined }));

    expect([malformed.status, opening.status, missing.status]).toEqual([400, 400, 400]);
    expect([malformed.body, opening.body, missing.body]).toEqual([invalid, invalid, invalid]);
  });

  test('404 wallet inexistente', async () => {
    const res = await post(request({ id: uuid(), playerId: uuid() }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'WALLET_NOT_FOUND', message: expect.any(String) } });
  });

  test('409 mesma Idempotency-Key com payload diferente', async () => {
    const wallet = await createWallet();
    const req = request(wallet);
    await post(req);

    const res = await post({ key: req.key, body: { ...req.body, money: brl('30.00') } });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: expect.any(String) } });
    await expectLedgerInvariant(app, wallet.id);
  });

  test('409 externalTransactionId reutilizado com outra Idempotency-Key', async () => {
    const wallet = await createWallet();
    const req = request(wallet);
    await post(req);

    const res = await post({ key: uuid(), body: req.body });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });
});

test('mesma BET 50 vezes em paralelo por HTTP: um 201 e 49 200, nenhum 503 nem erro', async () => {
  const wallet = await createWallet('100.00');
  const req = request(wallet, { money: brl('30.00') });

  const replies = await Promise.all(Array.from({ length: 50 }, () => post(req)));

  expect(replies.map((r) => r.status).sort()).toEqual([...Array(49).fill(200), 201]);
  expect(new Set(replies.map((r) => `${r.body.transactionId} ${r.body.status} ${r.body.balance.amount}`)).size).toBe(1);
  expect(replies.filter((r) => r.body.idempotentReplay)).toHaveLength(49);
  expect((await call('GET', `/wallets/${wallet.id}`)).body.balance).toEqual(brl('70.00'));
  await expectLedgerInvariant(app, wallet.id);
});

describe('falhas de infraestrutura e erro inesperado', () => {
  test('503 + Retry-After com o PostgreSQL inacessível', async () => {
    // porta 1: conexão recusada de verdade
    const down = await boot({ databaseUrl: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test' });
    try {
      const res = await call('POST', '/wallets', { playerId: uuid(), initialBalance: brl('1.00') }, {}, await down.getUrl());

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.body).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: expect.any(String) } });
    } finally {
      await down.close();
    }
  });

  test('503 + Retry-After com a wallet travada além do lock_timeout; nada gravado e o reenvio processa', async () => {
    const impatient = await boot({ dbLockTimeoutMs: 200 });
    try {
      const base = await impatient.getUrl();
      const wallet = await createWallet('100.00', base);
      const req = request(wallet);

      // outra conexão segura o FOR UPDATE da wallet enquanto a requisição chega
      const blocked = await db.em.fork().transactional(async (holder) => {
        await holder.execute('select id from wallets where id = ? for update', [wallet.id]);
        return post(req, base);
      });

      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('retry-after')).toBe('1');
      expect(blocked.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(await countRows(app, 'wager_transactions', 'external_transaction_id = ?', [req.body.externalTransactionId])).toBe(0);

      const retry = await post(req, base);
      expect(retry.status).toBe(201);
      expect(retry.body.idempotentReplay).toBe(false);
      await expectLedgerInvariant(app, wallet.id);
    } finally {
      await impatient.close();
    }
  });

  test('500 erro inesperado: código genérico, sem detalhe interno', async () => {
    const broken = await boot({}, (b) =>
      b.overrideProvider(Clock).useValue({
        now: () => {
          throw new Error('segredo interno: relógio quebrado');
        },
      }),
    );
    try {
      const res = await call('POST', '/wallets', { playerId: uuid(), initialBalance: brl('1.00') }, {}, await broken.getUrl());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno' } });
      expect(JSON.stringify(res.body)).not.toContain('segredo');
    } finally {
      await broken.close();
    }
  });
});

describe('wallets', () => {
  test('201 cria wallet com o corpo do enunciado; GET devolve o mesmo', async () => {
    const playerId = uuid();

    const created = await call('POST', '/wallets', { playerId, initialBalance: brl('1000.00') });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });
    const read = await call('GET', `/wallets/${created.body.id}`);
    expect([read.status, read.body]).toEqual([200, created.body]);
    await expectLedgerInvariant(app, created.body.id);
  });

  test('GET reflete saldo e version depois de uma aposta', async () => {
    const wallet = await createWallet('1000.00');
    await post(request(wallet));

    const read = await call('GET', `/wallets/${wallet.id}`);

    expect(read.body).toMatchObject({ balance: brl('975.00'), version: 2 });
  });

  test('409 wallet duplicada para o mesmo jogador e moeda', async () => {
    const playerId = uuid();
    await call('POST', '/wallets', { playerId, initialBalance: brl('1.00') });

    const res = await call('POST', '/wallets', { playerId, initialBalance: brl('1.00') });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'WALLET_ALREADY_EXISTS', message: expect.any(String) } });
  });

  test('400 entrada inválida na criação', async () => {
    for (const body of [
      { initialBalance: brl('1.00') },
      { playerId: '', initialBalance: brl('1.00') },
      { playerId: uuid(), initialBalance: brl('-1.00') },
      { playerId: uuid(), initialBalance: brl('10.005') },
      { playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } },
      { playerId: uuid() },
    ]) {
      const res = await call('POST', '/wallets', body);
      expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_PAYLOAD']);
    }
  });

  test('404 wallet inexistente; 400 id malformado', async () => {
    const missing = await call('GET', `/wallets/${uuid()}`);
    expect([missing.status, missing.body.error.code]).toEqual([404, 'WALLET_NOT_FOUND']);

    const ledger = await call('GET', `/wallets/${uuid()}/ledger`);
    expect([ledger.status, ledger.body.error.code]).toEqual([404, 'WALLET_NOT_FOUND']);

    const malformed = await call('GET', '/wallets/not-a-uuid');
    expect([malformed.status, malformed.body.error.code]).toEqual([400, 'INVALID_PAYLOAD']);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  const win = (wallet: { id: string; playerId: string }) => post(request(wallet, { kind: 'WIN', money: brl('1.00') }));
  const page = (walletId: string, query: string) => call('GET', `/wallets/${walletId}/ledger${query}`);

  test('páginas 2/2/1 sem repetição nem lacuna; lançamento novo só aparece no fim', async () => {
    const wallet = await createWallet('10.00'); // lançamento 1 (abertura)
    for (let i = 0; i < 4; i++) await win(wallet); // lançamentos 2..5

    const first = await page(wallet.id, '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.entries[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: brl('10.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('10.00'),
      createdAt: expect.any(String),
    });
    expect(first.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await page(wallet.id, `?limit=2&cursor=${first.body.nextCursor}`);
    const third = await page(wallet.id, `?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.entries).toHaveLength(1);
    expect(third.body.nextCursor).toBeUndefined();

    const seen: Json[] = [...first.body.entries, ...second.body.entries, ...third.body.entries];
    expect(seen.map((e) => e.balanceAfter.amount)).toEqual(['10.00', '11.00', '12.00', '13.00', '14.00']);
    expect(new Set(seen.map((e) => e.id)).size).toBe(5);

    await win(wallet); // gravado depois de a segunda página ter sido lida
    const after = await page(wallet.id, `?limit=2&cursor=${second.body.nextCursor}`);
    expect(after.body.entries.map((e: Json) => e.balanceAfter.amount)).toEqual(['14.00', '15.00']);
    expect(after.body.nextCursor).toBeUndefined();
    await expectLedgerInvariant(app, wallet.id);
  });

  test('limit padrão 50 e máximo 100', async () => {
    const wallet = await createWallet('10.00');
    await db.em.fork().transactional(async (em) => {
      // 119 lançamentos direto no banco (120 com a abertura): via API seriam 119 requisições
      await em.execute(
        `with tx as (
           insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
             player_id, round_id, game_id, kind, amount, currency, status, processed_at, completed_at,
             result_balance_amount, result_balance_currency, created_at)
           select gen_random_uuid(), 'seed', gen_random_uuid()::text, gen_random_uuid()::text, 'h', ?, 'p', 'r', 'g', 'WIN', 1, 'BRL',
             'PROCESSED', now(), now(), 10 + n, 'BRL', now() from generate_series(1, 119) n
           returning id, result_balance_amount as after)
         insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         select gen_random_uuid(), ?, id, 'CREDIT', 1, 'BRL', after - 1, after, now() from tx order by after`,
        [wallet.id, wallet.id],
      );
      await em.execute('update wallets set balance = 129, version = 120 where id = ?', [wallet.id]);
    });

    expect((await page(wallet.id, '')).body.entries).toHaveLength(50);
    const capped = await page(wallet.id, '?limit=1000');
    expect(capped.body.entries).toHaveLength(100);
    expect(capped.body.nextCursor).toBeDefined();
    await expectLedgerInvariant(app, wallet.id);
  });

  test('400 cursor ou limit inválido', async () => {
    const wallet = await createWallet();
    for (const query of ['?cursor=@@@', '?cursor=abc', '?limit=0', '?limit=-1', '?limit=abc', '?limit=1.5']) {
      const res = await page(wallet.id, query);
      expect([query, res.status, res.body.error?.code]).toEqual([query, 400, 'INVALID_PAYLOAD']);
    }
  });
});

describe('consulta de transação', () => {
  test('por id interno e por provedor + id externo devolvem a mesma representação', async () => {
    const wallet = await createWallet('1000.00');
    const req = request(wallet);
    const submittedTx = await post(req);

    const byId = await call('GET', `/wagering/transactions/${submittedTx.body.transactionId}`);
    const byExternal = await call('GET', `/providers/${req.body.providerId}/wagering/transactions/${req.body.externalTransactionId}`);

    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: submittedTx.body.transactionId,
      status: 'PROCESSED',
      balance: brl('975.00'),
      providerId: 'provider-a',
      externalTransactionId: req.body.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      createdAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect([byExternal.status, byExternal.body]).toEqual([200, byId.body]);
  });

  test('transação rejeitada é consultável: 200 com status REJECTED e failureCode', async () => {
    const wallet = await createWallet('1.00');
    const req = request(wallet);
    await post(req);

    const res = await call('GET', `/providers/${req.body.providerId}/wagering/transactions/${req.body.externalTransactionId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('1.00') });
  });

  test('404 transação inexistente nas duas rotas; 400 id malformado', async () => {
    const notFound = { error: { code: 'TRANSACTION_NOT_FOUND', message: expect.any(String) } };

    const byId = await call('GET', `/wagering/transactions/${uuid()}`);
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${uuid()}`);
    const malformed = await call('GET', '/wagering/transactions/abc');

    expect([byId.status, byId.body]).toEqual([404, notFound]);
    expect([byExternal.status, byExternal.body]).toEqual([404, notFound]);
    expect(malformed.status).toBe(400);
  });
});

describe('X-Correlation-Id', () => {
  const HEADER = 'x-correlation-id';
  const UUID = /^[0-9a-f-]{36}$/;
  /** correlationId gravado nos eventos que a transação gerou. */
  const eventCorrelations = async (transactionId: string) =>
    (
      await sql<{ correlation_id: string }>(
        db,
        `select distinct payload->>'correlationId' as correlation_id from outbox_messages
          where aggregate_id = ? or payload->'data'->>'transactionId' = ?`,
        [transactionId, transactionId],
      )
    ).map((row) => row.correlation_id);
  const submit = async (correlationId?: string) => {
    const { body, key } = request(await createWallet());
    return call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key, ...(correlationId !== undefined && { [HEADER]: correlationId }) });
  };

  test('informado: volta na resposta e vai para os eventos', async () => {
    const res = await submit('abc-123');

    expect(res.status).toBe(201);
    expect(res.headers.get(HEADER)).toBe('abc-123');
    expect(await eventCorrelations(res.body.transactionId)).toEqual(['abc-123']);
  });

  test('ausente: gerado, e é o mesmo dos eventos', async () => {
    const res = await submit();

    expect(res.headers.get(HEADER)).toMatch(UUID);
    expect(await eventCorrelations(res.body.transactionId)).toEqual([res.headers.get(HEADER)!]);
  });

  test('inválido (longo demais ou com caracteres fora do conjunto): ignorado e substituído', async () => {
    for (const invalid of ['x'.repeat(129), 'com espaço', 'aspas"{}']) {
      const res = await submit(invalid);

      expect(res.status).toBe(201);
      expect(res.headers.get(HEADER)).toMatch(UUID);
      expect(await eventCorrelations(res.body.transactionId)).toEqual([res.headers.get(HEADER)!]);
    }
  });

  test('respostas de erro também devolvem o header: 404, rota inexistente e JSON malformado', async () => {
    const notFound = await call('GET', `/wallets/${uuid()}`, undefined, { [HEADER]: 'abc-123' });
    const noRoute = await call('GET', '/nope', undefined, { [HEADER]: 'abc-123' });
    const malformed = await call('POST', '/wagering/transactions', '{"providerId": ', { 'content-type': 'application/json', [HEADER]: 'abc-123' });

    expect([notFound.status, noRoute.status, malformed.status]).toEqual([404, 404, 400]);
    expect([notFound, noRoute, malformed].map((r) => r.headers.get(HEADER))).toEqual(['abc-123', 'abc-123', 'abc-123']);
  });

  test('health e métricas também devolvem o header', async () => {
    for (const path of ['/health/live', '/metrics']) {
      expect((await fetch(`${url}${path}`)).headers.get(HEADER)).toMatch(UUID);
    }
  });
});

describe('formato de erro e autenticação', () => {
  test('rota inexistente responde no envelope de erro', async () => {
    const res = await call('GET', '/nope');
    expect([res.status, res.body]).toEqual([404, { error: { code: 'NOT_FOUND', message: expect.any(String) } }]);
  });

  test('AuthGuard substituído por um que nega tudo: negócio negado, health continua aberto', async () => {
    let denied: INestApplication | undefined;
    try {
      denied = await boot({}, (b) => b.overrideGuard(AuthGuard).useValue({ canActivate: () => false }));
      const base = await denied.getUrl();
      const id = uuid();

      const business = await Promise.all([
        call('POST', '/wallets', { playerId: id, initialBalance: brl('1.00') }, {}, base),
        call('GET', `/wallets/${id}`, undefined, {}, base),
        call('GET', `/wallets/${id}/ledger`, undefined, {}, base),
        call('POST', '/wagering/transactions', {}, { 'Idempotency-Key': id }, base),
        call('GET', `/wagering/transactions/${id}`, undefined, {}, base),
        call('GET', `/providers/p/wagering/transactions/${id}`, undefined, {}, base),
        call('POST', `/wallets/${id}/reconciliation`, undefined, {}, base),
      ]);

      expect(business.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
      expect(business[0]!.body).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String) } });
      expect(await countRows(app, 'wallets', 'player_id = ?', [id])).toBe(0);

      expect((await call('GET', '/health/live', undefined, {}, base)).status).toBe(200);
      const ready = await call('GET', '/health/ready', undefined, {}, base);
      expect([ready.status, ready.body]).toEqual([200, { status: 'ok', checks: { postgres: 'up', sqs: 'up' } }]);
      expect((await fetch(`${base}/metrics`)).status).toBe(200);
    } finally {
      await denied?.close();
    }
  });

  test('sem credenciais, o AuthGuard padrão atende os endpoints de negócio', async () => {
    const wallet = await createWallet();
    expect((await call('GET', `/wallets/${wallet.id}`)).status).toBe(200);
  });
});
