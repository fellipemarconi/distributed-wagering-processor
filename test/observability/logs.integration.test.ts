import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Clock } from '../../src/application/ports';
import { createLogger } from '../../src/logger';
import { boot, payload, uuid } from '../application/helpers';
import { DLQ, depth, envelope, mainEmpty, quiesce as quiesceQueues, send, waitFor } from '../consumer/helpers';
import { quiescePending, txRow } from '../pending-reference/helpers';
import { sql } from '../persistence/helpers';
import { spawnInstance, type Instance } from '../process';

// Processo real (`bun src/main.ts`) com consumidor e worker de pendentes ligados: o que se afirma
// aqui é o que sai de verdade no stdout/stderr, não argumentos de um logger espionado.
const admin = await boot();
let instance: Instance;
let lines: string[];
let logs: Record<string, any>[];

// valores distintos de qualquer outro número que apareça em uma linha de log
const OPENING = '731.37';
const BET = '19.91';
const TOO_MUCH = '9731.37';
const BY_QUEUE = '17.93';
const REFUND = '23.29';
const brl = (amount: string) => ({ amount, currency: 'BRL' });

const ids = {} as Record<
  'wallet' | 'player' | 'bet' | 'rejected' | 'queued' | 'queuedMessage' | 'deadMessage' | 'deadWallet' | 'refund' | 'unknownRoute',
  string
>;

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${instance.base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, correlationId: res.headers.get('x-correlation-id')! };
}

function submit(body: ReturnType<typeof payload>, correlationId: string) {
  const { idempotencyKey, ...rest } = body;
  return http('POST', '/wagering/transactions', rest, { 'Idempotency-Key': idempotencyKey, 'X-Correlation-Id': correlationId });
}

beforeAll(async () => {
  await quiesceQueues();
  await quiescePending(admin);
  instance = await spawnInstance({
    SQS_CONSUMER_ENABLED: 'true',
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
  });

  // HTTP: wallet, aposta aplicada, aposta rejeitada
  ids.player = uuid();
  const created = await http('POST', '/wallets', { playerId: ids.player, initialBalance: brl(OPENING) }, { 'X-Correlation-Id': 'corr-wallet' });
  ids.wallet = created.body.id;
  const w = { id: ids.wallet, playerId: ids.player };
  ids.bet = (await submit(payload(w, { money: brl(BET) }), 'corr-bet')).body.transactionId;
  ids.rejected = (await submit(payload(w, { money: brl(TOO_MUCH) }), 'corr-rejected')).body.transactionId;

  // fila: uma mensagem aplicada e uma para a DLQ (wallet inexistente)
  const queued = envelope(payload(w, { money: brl(BY_QUEUE) }));
  const dead = envelope(payload({ id: uuid(), playerId: uuid() }, { money: brl(BY_QUEUE) }));
  ids.queuedMessage = queued.messageId;
  ids.deadMessage = dead.messageId;
  ids.deadWallet = dead.data.walletId;
  await send(queued);
  await send(dead);
  await waitFor(async () => (await mainEmpty()) && (await depth(DLQ)) === 1, 20_000);
  ids.queued = (await sql<{ id: string }>(admin.get(MikroORM), 'select id from wager_transactions where external_transaction_id = ?', [queued.data.externalTransactionId]))[0]!.id;

  // worker: REFUND antes da BET; a BET chega e o worker conclui a pendente
  const late = payload(w, { money: brl(REFUND) });
  const refund = await submit(payload(w, { kind: 'REFUND', money: brl(REFUND), referenceExternalTransactionId: late.externalTransactionId }), 'corr-refund');
  expect(refund.status).toBe(202);
  ids.refund = refund.body.transactionId;
  await submit(late, 'corr-late-bet');
  await waitFor(async () => (await txRow(admin, ids.refund)).status === 'PROCESSED');

  // reconciliação divergente: saldo adulterado direto no banco
  await sql(admin.get(MikroORM), 'update wallets set balance = balance + 10 where id = ?', [ids.wallet]);
  expect((await http('POST', `/wallets/${ids.wallet}/reconciliation`, undefined, { 'X-Correlation-Id': 'corr-reconcile' })).body.consistent).toBe(false);

  await http('GET', '/rota-inexistente', undefined, { 'X-Correlation-Id': 'corr-404' });

  instance.proc.kill('SIGTERM');
  await instance.proc.exited;
  lines = instance.lines();
  logs = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}, 60_000);

afterAll(async () => {
  instance?.proc.kill('SIGKILL');
  await quiesceQueues();
  await admin.close();
});

const find = (where: Record<string, unknown>) => logs.filter((entry) => Object.entries(where).every(([key, value]) => entry[key] === value));

test('toda linha escrita pelo processo é um objeto JSON com timestamp, nível e mensagem em texto', () => {
  expect(lines.length).toBeGreaterThan(10);
  for (const line of lines) {
    const entry = JSON.parse(line);
    expect(typeof entry.message).toBe('string');
    expect(entry.level).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  }
});

test('HTTP: um log de acesso por requisição, com correlationId do header e os ids da transação', () => {
  expect(find({ correlationId: 'corr-bet', message: 'Requisição atendida' })).toMatchObject([
    {
      level: 'log',
      method: 'POST',
      path: '/wagering/transactions',
      status: 201,
      durationMs: expect.any(Number),
      transactionId: ids.bet,
      walletId: ids.wallet,
      providerId: 'provider-a',
    },
  ]);
  expect(find({ correlationId: 'corr-rejected', message: 'Requisição atendida' })).toMatchObject([
    { status: 422, transactionId: ids.rejected, walletId: ids.wallet, providerId: 'provider-a' },
  ]);
  expect(find({ correlationId: 'corr-wallet', message: 'Requisição atendida' })).toMatchObject([
    { method: 'POST', path: '/wallets', status: 201, walletId: ids.wallet },
  ]);
  expect(find({ correlationId: 'corr-404', message: 'Requisição atendida' })).toMatchObject([{ path: '/rota-inexistente', status: 404 }]);
});

test('health não gera log de acesso no nível padrão', () => {
  expect(logs.filter((entry) => typeof entry.path === 'string' && entry.path.startsWith('/health'))).toEqual([]);
});

test('consumidor: desfecho com correlationId = messageId, transactionId, walletId e providerId', () => {
  expect(find({ messageId: ids.queuedMessage, message: 'Mensagem consumida' })).toMatchObject([
    {
      outcome: 'processed',
      correlationId: ids.queuedMessage,
      transactionId: ids.queued,
      walletId: ids.wallet,
      providerId: 'provider-a',
    },
  ]);
});

test('consumidor: log de DLQ com os ids da mensagem e o motivo', () => {
  expect(find({ messageId: ids.deadMessage })).toMatchObject([
    {
      level: 'warn',
      message: 'Mensagem enviada para a DLQ',
      reason: 'WALLET_NOT_FOUND',
      correlationId: ids.deadMessage,
      walletId: ids.deadWallet,
      providerId: 'provider-a',
    },
  ]);
});

test('worker de pendentes: conclusão com correlationId = transactionId, walletId e providerId', () => {
  expect(find({ transactionId: ids.refund, outcome: 'processed' })).toMatchObject([
    {
      message: 'Pendente de referência reavaliada',
      correlationId: ids.refund,
      walletId: ids.wallet,
      providerId: 'provider-a',
      kind: 'REFUND',
    },
  ]);
});

test('reconciliação divergente: uma linha de erro com walletId e correlationId, sem valores', () => {
  const entries = find({ correlationId: 'corr-reconcile', level: 'error' });

  expect(entries).toMatchObject([{ walletId: ids.wallet, balanceMatches: false, chainIntact: false, checkedEntries: expect.any(Number) }]);
  expect(Object.keys(entries[0]!)).not.toContain('difference');
});

test('nenhuma linha contém valores monetários nem campos de valor, saldo ou payload', () => {
  const output = lines.join('\n');
  for (const amount of [OPENING, BET, TOO_MUCH, BY_QUEUE, REFUND, '741.37']) expect(output).not.toContain(amount);
  expect(output).not.toMatch(/"(amount|money|balance|storedBalance|calculatedBalance|difference|payload|body|data)"/);
});

test('erro interno: o log de erro tem o mesmo correlationId devolvido na resposta', async () => {
  const broken = await boot({}, (b) =>
    b.overrideProvider(Clock).useValue({
      now: () => {
        throw new Error('relógio quebrado');
      },
    }),
  );
  broken.useLogger(createLogger('log'));
  const written: string[] = [];
  const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));
  try {
    const res = await fetch(`${await broken.getUrl()}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Correlation-Id': 'corr-500' },
      body: JSON.stringify({ playerId: uuid(), initialBalance: brl('1.00') }),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('x-correlation-id')).toBe('corr-500');
    const errors = written.map((line) => JSON.parse(line)).filter((entry) => entry.level === 'error');
    expect(errors).toMatchObject([{ correlationId: 'corr-500', message: expect.stringContaining('relógio quebrado') }]);
  } finally {
    stderr.mockRestore();
    await broken.close();
  }
});
