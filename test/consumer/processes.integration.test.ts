import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config';
import { balanceOf, boot, countRows, expectLedgerInvariant, ledgerOf, openWallet, payload } from '../application/helpers';
import { sql } from '../persistence/helpers';
import { spawnInstance, type Instance } from '../process';
import { DLQ, MAIN, depth, drain, envelope, holdingLock, inboxOf, mainEmpty, quiesce, send, transactionsOf, waitFor } from './helpers';

// Processos reais (`bun src/main.ts`): sinais de verdade, nenhum gancho de teste no código de produção.
const admin = await boot();
beforeEach(quiesce);
afterAll(() => admin.close());

const CONSUMER = { SQS_CONSUMER_ENABLED: 'true', SQS_CONSUMER_WAIT_TIME_SECONDS: '1' };

/** Entradas de log do consumidor de um processo (o Nest aninha o objeto logado em `message`). */
const consumerLogs = (instance: Instance) =>
  instance
    .logs()
    .map((line) => line.message)
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && 'outcome' in entry);

async function stop(instance: Instance, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  instance.proc.kill(signal);
  await instance.proc.exited;
}

test('worker morto depois do commit e antes do ack: a mensagem reaparece, a inbox deduplica e o saldo fica íntegro', async () => {
  // Proxy na frente do LocalStack que nunca responde a DeleteMessage: o processo confirma a
  // transação no banco e fica preso no ack — é aí que ele morre.
  const upstream = loadConfig().awsEndpointUrl;
  const proxy = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.headers.get('x-amz-target')?.endsWith('.DeleteMessage')) return new Promise<Response>(() => {});
      const headers = new Headers(request.headers);
      headers.delete('host');
      const response = await fetch(upstream + new URL(request.url).pathname, { method: request.method, headers, body: await request.arrayBuffer() });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/x-amz-json-1.0' },
      });
    },
  });

  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const message = envelope(data);
  await send(message);

  const victim = await spawnInstance({
    ...CONSUMER,
    AWS_ENDPOINT_URL: `http://127.0.0.1:${proxy.port}`,
    DB_LOCK_TIMEOUT_MS: '1000',
    SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '8', // acima da margem (1s + 5s) e curto para o teste
  });
  try {
    await waitFor(async () => (await inboxOf(admin, message.messageId)).length === 1); // commit confirmado
  } finally {
    await stop(victim, 'SIGKILL');
    await proxy.stop(true);
  }
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  expect(await depth(MAIN)).toBe(1); // nunca foi apagada

  const log = spyOn(Logger.prototype, 'log');
  const survivor = await boot({ sqsConsumerEnabled: true, sqsConsumerWaitTimeSeconds: 1 });
  try {
    await waitFor(mainEmpty, 20_000); // reaparece quando a visibilidade de 8s vence
    const entries = log.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((e) => e.messageId === message.messageId);
    expect(entries).toMatchObject([{ outcome: 'duplicate', receiveCount: 2 }]);
  } finally {
    log.mockRestore();
    await survivor.close();
  }

  expect(await inboxOf(admin, message.messageId)).toHaveLength(1);
  expect(await transactionsOf(admin, data.externalTransactionId)).toHaveLength(1);
  expect(await ledgerOf(admin, w.id)).toHaveLength(2);
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  expect(await depth(DLQ)).toBe(0);
  await expectLedgerInvariant(admin, w.id);
}, 60_000);

test('SIGTERM com mensagem em andamento: ela é concluída e a não iniciada volta para a fila na hora', async () => {
  const w = await openWallet(admin, '100.00');
  const inProgress = envelope(payload(w));
  const notStarted = envelope(payload(w));
  // mesmo grupo e enviadas antes de o processo subir: chegam no mesmo receive, processadas em série
  await send(inProgress, { groupId: w.id });
  await send(notStarted, { groupId: w.id });

  const waitingOnLock = async () =>
    Number(
      (await sql<{ n: string }>(admin.get(MikroORM), `select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0]!.n,
    ) > 0;

  let instance!: Instance;
  await holdingLock(admin, w.id, async () => {
    // lock_timeout alto: a primeira mensagem fica "em andamento", esperando a wallet
    instance = await spawnInstance({ ...CONSUMER, DB_LOCK_TIMEOUT_MS: '15000' });
    await waitFor(waitingOnLock);
    instance.proc.kill('SIGTERM');
    await Bun.sleep(500); // o shutdown já começou quando a wallet for liberada
    expect(instance.proc.exitCode).toBeNull(); // segue vivo: há mensagem em andamento
  });
  await instance.proc.exited;

  expect(consumerLogs(instance).map((e) => [e.messageId, e.outcome, e.why])).toEqual([
    [inProgress.messageId, 'processed', undefined],
    [notStarted.messageId, 'released', 'shutdown'],
  ]);
  expect(await transactionsOf(admin, inProgress.data.externalTransactionId)).toMatchObject([{ status: 'PROCESSED' }]);
  expect(await inboxOf(admin, inProgress.messageId)).toHaveLength(1);
  expect(await transactionsOf(admin, notStarted.data.externalTransactionId)).toEqual([]);

  // recebível agora, sem esperar os 30s de visibilidade
  const returned = await drain(MAIN);
  expect(returned.map((m) => JSON.parse(m.body).messageId)).toEqual([notStarted.messageId]);
  expect(returned[0]!.receiveCount).toBe(2);
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  await expectLedgerInvariant(admin, w.id);
}, 60_000);

test('três instâncias na mesma fila, apostas concorrentes na mesma wallet: nenhum débito duplicado e saldo igual ao do ledger', async () => {
  const BETS = 60; // 60 × 25.00 contra 1000.00: 40 cabem, 20 são rejeitadas
  const w = await openWallet(admin, '1000.00');
  const bets = Array.from({ length: BETS }, () => envelope(payload(w)));
  const resentWithNewMessageId = bets.slice(0, 10).map((bet) => envelope(bet.data)); // replay pela chave de idempotência
  const redelivered = bets.slice(10, 20); // mesma mensagem de novo: inbox
  // Um grupo FIFO por envio: sem a serialização do broker, as instâncias disputam a wallet de verdade.
  await Promise.all([...bets, ...resentWithNewMessageId, ...redelivered].map((body) => send(body)));

  const instances = await Promise.all([1, 2, 3].map(() => spawnInstance(CONSUMER)));
  try {
    await waitFor(mainEmpty, 60_000);
  } finally {
    await Promise.all(instances.map((instance) => stop(instance, 'SIGTERM')));
  }

  const externalIds = bets.map((bet) => bet.data.externalTransactionId);
  const transactions = await sql<{ external_transaction_id: string; status: string }>(
    admin.get(MikroORM),
    'select external_transaction_id, status from wager_transactions where wallet_id = ? and kind = ?',
    [w.id, 'BET'],
  );
  expect(transactions.map((t) => t.external_transaction_id).sort()).toEqual([...externalIds].sort()); // uma por aposta
  expect(transactions.filter((t) => t.status === 'PROCESSED')).toHaveLength(40);
  expect(transactions.filter((t) => t.status === 'REJECTED')).toHaveLength(20);

  const ledger = await ledgerOf(admin, w.id);
  expect(ledger.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(40);
  expect(new Set(ledger.map((entry) => entry.transaction_id)).size).toBe(ledger.length);
  expect(await balanceOf(admin, w.id)).toBe('0.00');
  await expectLedgerInvariant(admin, w.id);

  const messageIds = [...bets, ...resentWithNewMessageId].map((m) => m.messageId);
  expect(await countRows(admin, 'inbox_messages', `message_id in (${messageIds.map(() => '?').join(', ')})`, messageIds)).toBe(70);
  expect(await depth(DLQ)).toBe(0);

  // as 80 entregas foram tratadas, e por mais de uma instância
  const handled = instances.map((instance) => consumerLogs(instance).filter((e) => e.outcome !== 'released' && e.outcome !== 'retry').length);
  expect(handled.reduce((sum, n) => sum + n, 0)).toBe(80);
  expect(handled.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
}, 120_000);
