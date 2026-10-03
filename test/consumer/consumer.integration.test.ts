import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import {
  balanceOf,
  boot,
  eventsOf,
  expectLedgerInvariant,
  ledgerOf,
  openWallet,
  payload,
  uuid,
} from '../application/helpers';
import { DB_DOWN, DLQ, MAIN, depth, drain, envelope, holdingLock, inboxOf, mainEmpty, quiesce, send, transactionsOf, waitFor } from './helpers';

// `admin` não consome: serve para gravar, consultar e atender HTTP. Os consumidores nascem em cada teste.
const admin = await boot();
const running: INestApplication[] = [];
const start = async (overrides: Parameters<typeof boot>[0] = {}) => {
  const app = await boot({ sqsConsumerEnabled: true, sqsConsumerWaitTimeSeconds: 1, ...overrides });
  running.push(app);
  return app;
};
const close = async (app: INestApplication) => {
  running.splice(running.indexOf(app), 1);
  await app.close();
};

beforeEach(quiesce);
afterEach(() => Promise.all(running.splice(0).map((app) => app.close())));
afterAll(() => admin.close());

/** Entradas de log do consumidor (objetos) capturadas enquanto `run` executa. */
async function capturingLogs<T>(run: (entries: () => Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const spies = (['log', 'warn', 'error'] as const).map((level) => spyOn(Logger.prototype, level));
  const entries = () =>
    spies
      .flatMap((spy) => spy.mock.calls.map((call) => call[0] as unknown))
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && 'outcome' in entry);
  try {
    return await run(entries);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const holdingWalletLock = <T>(walletId: string, during: () => Promise<T>) => holdingLock(admin, walletId, during);

test('instância com consumidor ligado processa, grava a outbox e apaga a mensagem', async () => {
  await start();
  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const message = envelope(data);

  await send(message);
  await waitFor(mainEmpty);

  const [tx] = await transactionsOf(admin, data.externalTransactionId);
  expect(tx!.status).toBe('PROCESSED');
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  expect(await eventsOf(admin, tx!.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(await inboxOf(admin, message.messageId)).toHaveLength(1);
  expect(await depth(DLQ)).toBe(0);
  await expectLedgerInvariant(admin, w.id);
});

test('instância com consumidor desligado deixa a mensagem na fila', async () => {
  const w = await openWallet(admin, '100.00');
  const data = payload(w);

  await send(envelope(data));
  await Bun.sleep(500);

  expect(await depth(MAIN)).toBe(1);
  expect(await transactionsOf(admin, data.externalTransactionId)).toEqual([]);
});

test('mesma mensagem entregue duas vezes: um único efeito e as duas entregas apagadas', async () => {
  await start();
  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const message = envelope(data);

  await send(message, { groupId: w.id });
  await send(message, { groupId: w.id }); // outro dedup id: para o SQS é outra entrega
  await waitFor(mainEmpty);

  expect(await inboxOf(admin, message.messageId)).toHaveLength(1);
  expect(await transactionsOf(admin, data.externalTransactionId)).toHaveLength(1);
  expect(await ledgerOf(admin, w.id)).toHaveLength(2);
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  expect(await depth(DLQ)).toBe(0);
  await expectLedgerInvariant(admin, w.id);
});

test('duas instâncias com a mesma mensagem: um único efeito, nada na DLQ', async () => {
  await Promise.all([start(), start()]);
  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const message = envelope(data);

  // grupos diferentes: as duas entregas podem estar em voo ao mesmo tempo, uma em cada instância
  await Promise.all([send(message), send(message)]);
  await waitFor(mainEmpty);

  expect(await inboxOf(admin, message.messageId)).toHaveLength(1);
  expect(await ledgerOf(admin, w.id)).toHaveLength(2);
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  expect(await depth(DLQ)).toBe(0);
  await expectLedgerInvariant(admin, w.id);
});

test('rejeição de negócio: ack, inbox gravada, evento na outbox e nada na DLQ', async () => {
  await start();
  const w = await openWallet(admin, '10.00');
  const data = payload(w); // 25.00 > 10.00
  const message = envelope(data);

  await send(message);
  await waitFor(mainEmpty);

  const [tx] = await transactionsOf(admin, data.externalTransactionId);
  expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  expect(await eventsOf(admin, tx!.id)).toEqual(['WagerTransactionRejected']);
  expect(await inboxOf(admin, message.messageId)).toHaveLength(1);
  expect(await depth(DLQ)).toBe(0);
  expect(await balanceOf(admin, w.id)).toBe('10.00');
  await expectLedgerInvariant(admin, w.id);
});

test('erros permanentes vão para a DLQ com o motivo e saem da fila principal, sem inbox', async () => {
  await start();
  const w = await openWallet(admin, '100.00');
  const original = payload(w);
  await send(envelope(original));
  await waitFor(mainEmpty);

  const cases: Record<string, unknown> = {
    INVALID_ENVELOPE: 'isto não é json',
    INVALID_PAYLOAD: envelope({ ...payload(w), money: { amount: '25.001', currency: 'BRL' } }),
    WALLET_NOT_FOUND: envelope(payload({ id: uuid(), playerId: uuid() })),
    IDEMPOTENCY_KEY_CONFLICT: envelope({ ...original, money: { amount: '30.00', currency: 'BRL' } }),
    EXTERNAL_TRANSACTION_CONFLICT: envelope({ ...original, idempotencyKey: `outra-${uuid()}` }),
  };
  const opening = envelope({ ...payload(w), kind: 'OPENING' });
  const bodyOf = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

  for (const body of [...Object.values(cases), opening]) await send(body);
  await waitFor(mainEmpty);

  const dead = await drain(DLQ);
  const reasonOf = (body: unknown) => dead.find((m) => m.body === bodyOf(body))?.reason;
  expect(dead).toHaveLength(6);
  for (const [reason, body] of Object.entries(cases)) expect(reasonOf(body)).toBe(reason);
  expect(reasonOf(opening)).toBe('INVALID_PAYLOAD');

  for (const body of [opening, ...Object.values(cases)]) {
    if (typeof body !== 'string') expect(await inboxOf(admin, (body as { messageId: string }).messageId)).toEqual([]);
  }
  expect(await balanceOf(admin, w.id)).toBe('75.00'); // só a BET original
  await expectLedgerInvariant(admin, w.id);
});

describe('mesma chave de idempotência por HTTP e pela fila', () => {
  const post = async (data: ReturnType<typeof payload>) => {
    const { idempotencyKey, ...body } = data;
    const response = await fetch(`${await admin.getUrl()}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  test('HTTP e depois fila: a mensagem é confirmada como replay, sem segundo efeito nem evento novo', async () => {
    await start();
    const w = await openWallet(admin, '100.00');
    const data = payload(w);
    const first = await post(data);
    expect(first.status).toBe(201);
    const message = envelope(data);

    await send(message);
    await waitFor(mainEmpty);

    expect(await transactionsOf(admin, data.externalTransactionId)).toHaveLength(1);
    expect(await ledgerOf(admin, w.id)).toHaveLength(2);
    expect(await eventsOf(admin, first.body.transactionId as string)).toHaveLength(2);
    expect(await inboxOf(admin, message.messageId)).toHaveLength(1);
    expect(await depth(DLQ)).toBe(0);
    expect(await balanceOf(admin, w.id)).toBe('75.00');
    await expectLedgerInvariant(admin, w.id);
  });

  test('fila e depois HTTP: a resposta é replay com o resultado original', async () => {
    await start();
    const w = await openWallet(admin, '100.00');
    const data = payload(w);
    await send(envelope(data));
    await waitFor(mainEmpty);
    const [tx] = await transactionsOf(admin, data.externalTransactionId);

    const replay = await post(data);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: tx!.id,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(await balanceOf(admin, w.id)).toBe('75.00');
    await expectLedgerInvariant(admin, w.id);
  });
});

test('ordem dentro do grupo: BET e o REFUND dela no mesmo lote ficam PROCESSED, nunca PENDING_REFERENCE', async () => {
  const w = await openWallet(admin, '100.00');
  const bet = payload(w);
  const refund = payload(w, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
  // enviadas antes de o consumidor subir: chegam no mesmo receive
  await send(envelope(bet), { groupId: w.id });
  await send(envelope(refund), { groupId: w.id });

  await start();
  await waitFor(mainEmpty);

  expect((await transactionsOf(admin, bet.externalTransactionId))[0]!.status).toBe('PROCESSED');
  expect((await transactionsOf(admin, refund.externalTransactionId))[0]!.status).toBe('PROCESSED');
  expect(await balanceOf(admin, w.id)).toBe('100.00');
  await expectLedgerInvariant(admin, w.id);
});

test('falha transitória segura o grupo: a seguinte é devolvida sem iniciar e a ordem se mantém', async () => {
  const w = await openWallet(admin, '100.00');
  const bet = envelope(payload(w));
  const refund = envelope(payload(w, { kind: 'REFUND', referenceExternalTransactionId: bet.data.externalTransactionId }));
  await send(bet, { groupId: w.id });
  await send(refund, { groupId: w.id });

  await capturingLogs(async (entries) => {
    const of = (messageId: string, outcome: string) => entries().filter((e) => e.messageId === messageId && e.outcome === outcome);
    await holdingWalletLock(w.id, async () => {
      // lock_timeout de 1s: a BET estoura a espera (55P03) com a wallet travada
      await start({ dbLockTimeoutMs: 1000, sqsConsumerMaxBackoffSeconds: 1 });
      await waitFor(async () => of(bet.messageId, 'retry').length > 0);
      await waitFor(async () => of(refund.messageId, 'released').length > 0);
    });
    expect(of(bet.messageId, 'retry')[0]).toMatchObject({ transient: true, walletId: w.id, providerId: 'provider-a' });
    expect(of(refund.messageId, 'released')[0]).toMatchObject({ why: 'blocked' });
    expect(of(refund.messageId, 'retry')).toEqual([]); // nunca chegou a ser iniciada com a wallet travada

    await waitFor(mainEmpty);
  });

  expect((await transactionsOf(admin, bet.data.externalTransactionId))[0]!.status).toBe('PROCESSED');
  expect((await transactionsOf(admin, refund.data.externalTransactionId))[0]!.status).toBe('PROCESSED');
  expect(await depth(DLQ)).toBe(0);
  expect(await balanceOf(admin, w.id)).toBe('100.00');
  await expectLedgerInvariant(admin, w.id);
}, 30_000);

test('margem de visibilidade: mensagem do grupo que começaria perto do fim da visibilidade é devolvida sem iniciar', async () => {
  // lock de 6s → margem de 11s; visibilidade de 13s → só inicia mensagem até 2s depois do receive
  const SLOW = { dbLockTimeoutMs: 6000, sqsConsumerVisibilityTimeoutSeconds: 13 };
  const w = await openWallet(admin, '100.00');
  const first = envelope(payload(w));
  const second = envelope(payload(w));
  await send(first, { groupId: w.id });
  await send(second, { groupId: w.id });

  await capturingLogs(async (entries) => {
    const of = (messageId: string) => entries().filter((e) => e.messageId === messageId).map((e) => e.outcome);
    await holdingWalletLock(w.id, async () => {
      await start(SLOW);
      await Bun.sleep(4000); // a primeira espera o lock por 4s: conclui, mas já fora da janela de 2s
    });
    await waitFor(mainEmpty);

    expect(of(first.messageId)).toEqual(['processed']);
    // devolvida antes de qualquer processamento, e processada uma única vez na entrega seguinte
    expect(of(second.messageId)).toEqual(['released', 'processed']);
    expect(entries().find((e) => e.messageId === second.messageId)).toMatchObject({ why: 'visibility' });
  });

  for (const message of [first, second]) {
    expect(await transactionsOf(admin, message.data.externalTransactionId)).toMatchObject([{ status: 'PROCESSED' }]);
  }
  expect(await ledgerOf(admin, w.id)).toHaveLength(3);
  expect(await balanceOf(admin, w.id)).toBe('50.00');
  expect(await depth(DLQ)).toBe(0);
  await expectLedgerInvariant(admin, w.id);
}, 30_000);

test('erro transitório (banco inacessível): mensagem não é apagada nem vai para a DLQ, e é processada depois', async () => {
  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const message = envelope(data);

  await capturingLogs(async (entries) => {
    const down = await start({ ...DB_DOWN, sqsConsumerMaxBackoffSeconds: 1 });
    await send(message);
    await waitFor(async () => entries().some((e) => e.messageId === message.messageId && e.outcome === 'retry'));
    await close(down);

    expect(entries().find((e) => e.outcome === 'retry')).toMatchObject({ transient: true, receiveCount: 1, delaySeconds: 1 });
    expect(await depth(MAIN)).toBe(1);
    expect(await depth(DLQ)).toBe(0);
    expect(await transactionsOf(admin, data.externalTransactionId)).toEqual([]);
    expect(await inboxOf(admin, message.messageId)).toEqual([]);

    await start();
    await waitFor(mainEmpty);

    const consumed = entries().filter((e) => e.messageId === message.messageId && e.outcome === 'processed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!.receiveCount as number).toBeGreaterThan(1);
  });

  expect(await transactionsOf(admin, data.externalTransactionId)).toMatchObject([{ status: 'PROCESSED' }]);
  expect(await balanceOf(admin, w.id)).toBe('75.00');
  expect(await depth(DLQ)).toBe(0);
  await expectLedgerInvariant(admin, w.id);
}, 30_000);

test('excesso de recebimentos: o redrive move a mensagem para a DLQ, sem motivo e sem efeito', async () => {
  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const body = JSON.stringify(envelope(data));

  await start({ ...DB_DOWN, sqsConsumerMaxBackoffSeconds: 1 });
  await send(body);
  // maxReceiveCount = 8, com backoff limitado a 1s por recebimento
  await waitFor(async () => (await depth(DLQ)) === 1, 50_000);

  expect(await depth(MAIN)).toBe(0);
  const [dead] = await drain(DLQ);
  expect(dead!.body).toBe(body);
  expect(dead!.reason).toBeUndefined(); // chegou pelo redrive, não por decisão do consumidor
  expect(await transactionsOf(admin, data.externalTransactionId)).toEqual([]);
  expect(await balanceOf(admin, w.id)).toBe('100.00');
}, 60_000);

test('log por mensagem: ids de correlação e desfecho, sem corpo nem valores', async () => {
  await start();
  const w = await openWallet(admin, '100.00');
  const data = payload(w, { money: { amount: '31.37', currency: 'BRL' } });
  const ok = envelope(data);
  const lost = envelope(payload({ id: uuid(), playerId: uuid() }, { money: { amount: '31.37', currency: 'BRL' } }));

  await capturingLogs(async (entries) => {
    const warn = spyOn(Logger.prototype, 'warn');
    await send(ok);
    await send(lost);
    await waitFor(async () => entries().length >= 2);
    await waitFor(mainEmpty);

    const [tx] = await transactionsOf(admin, data.externalTransactionId);
    expect(entries().find((e) => e.messageId === ok.messageId)).toEqual({
      message: 'Mensagem consumida',
      outcome: 'processed',
      correlationId: ok.messageId,
      messageId: ok.messageId,
      transactionId: tx!.id,
      walletId: w.id,
      providerId: 'provider-a',
      receiveCount: 1,
    });
    const dead = warn.mock.calls.map((call) => call[0] as Record<string, unknown>).find((e) => e.messageId === lost.messageId);
    expect(dead).toMatchObject({ outcome: 'dead', reason: 'WALLET_NOT_FOUND', correlationId: lost.messageId, providerId: 'provider-a' });

    const logged = JSON.stringify(entries());
    expect(logged).not.toContain('31.37'); // valor da operação
    expect(logged).not.toContain('68.63'); // saldo resultante
    expect(logged).not.toContain(data.externalTransactionId); // nada do corpo além dos ids de log
    warn.mockRestore();
  });
});

test('shutdown em long polling: espera o receive em curso e devolve na hora a mensagem que chegar nele', async () => {
  const w = await openWallet(admin, '100.00');
  const data = payload(w);
  const app = await start({ sqsConsumerWaitTimeSeconds: 3 });
  await Bun.sleep(300); // o receive já está aberto

  const started = Date.now();
  const closing = close(app);
  await send(envelope(data)); // chega ao receive de uma instância que já está parando
  await closing;

  expect(Date.now() - started).toBeLessThan(4000); // no máximo o tempo do long polling
  // não iniciada e não presa pela visibilidade (30s): outra instância a recebe em seguida
  expect(await transactionsOf(admin, data.externalTransactionId)).toEqual([]);
  const [returned] = await drain(MAIN);
  expect(returned!.receiveCount).toBe(2);
});
