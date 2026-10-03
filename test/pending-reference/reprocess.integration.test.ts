import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  balanceOf,
  boot,
  countRows,
  eventsOf,
  expectLedgerInvariant,
  ledgerOf,
  openWallet,
  payload,
  submit,
  submitted,
} from '../application/helpers';
import {
  IN_BACKOFF,
  drainPending,
  failFirstOutboxAdd,
  patchTx,
  quiescePending,
  referencing,
  reprocess,
  resolutionEvents,
  secondsAgo,
  txRow,
} from './helpers';

// Worker desligado (test/setup.ts): cada teste roda os lotes na mão, sem depender de polling.
const app = await boot();
const other = await boot(); // segunda instância, para os testes de concorrência
const flaky = await boot({}, failFirstOutboxAdd);
const url = await app.getUrl();
afterAll(() => Promise.all([app.close(), other.close(), flaky.close()]));
beforeEach(() => quiescePending(app));

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const TTL_SECONDS = 900;

describe('referência resolvida', () => {
  test('REFUND chega antes da BET; a BET chega; o worker aplica o REFUND', async () => {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const refund = await submitted(app, referencing(w, betInput.externalTransactionId));
    expect(refund.status).toBe('PENDING_REFERENCE');
    const bet = await submitted(app, betInput);
    expect(await balanceOf(app, w.id)).toBe('75.00');

    expect(await reprocess(app)).toMatchObject({ selected: 1, processed: 1 });

    expect(await txRow(app, refund.id)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: bet.id,
      result_balance_amount: '100.00',
      reference_attempts: 0,
    });
    expect(await balanceOf(app, w.id)).toBe('100.00');
    const ledger = await ledgerOf(app, w.id);
    expect(ledger.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']); // abertura, BET, REFUND
    expect(ledger.at(-1)).toMatchObject({ transaction_id: refund.id, amount: '25.00', balance_before: '75.00', balance_after: '100.00' });
    // os eventos do worker carregam o id da transação como correlação
    expect(await resolutionEvents(app, refund.id)).toEqual([
      { event_type: 'WagerTransactionProcessed', correlation_id: refund.id, failure_code: null },
      { event_type: 'WalletBalanceChanged', correlation_id: refund.id, failure_code: null },
    ]);
    await expectLedgerInvariant(app, w.id);
  });

  test('ROLLBACK de WIN chega antes do WIN: DEBIT do valor do WIN', async () => {
    const w = await openWallet(app, '100.00');
    const winInput = payload(w, { kind: 'WIN', money: brl('50.00') });
    const rollback = await submitted(app, referencing(w, winInput.externalTransactionId, { kind: 'ROLLBACK', money: brl('50.00') }));
    expect(rollback.status).toBe('PENDING_REFERENCE');
    await submitted(app, winInput);
    expect(await balanceOf(app, w.id)).toBe('150.00');

    expect(await reprocess(app)).toMatchObject({ selected: 1, processed: 1 });

    expect((await txRow(app, rollback.id)).status).toBe('PROCESSED');
    expect((await ledgerOf(app, w.id)).at(-1)).toMatchObject({ transaction_id: rollback.id, direction: 'DEBIT', amount: '50.00' });
    expect(await balanceOf(app, w.id)).toBe('100.00');
    await expectLedgerInvariant(app, w.id);
  });

  test('WIN que aguardava a BET: CREDIT', async () => {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const win = await submitted(app, referencing(w, betInput.externalTransactionId, { kind: 'WIN', money: brl('40.00') }));
    expect(win.status).toBe('PENDING_REFERENCE');
    await submitted(app, betInput);

    expect(await reprocess(app)).toMatchObject({ selected: 1, processed: 1 });

    expect((await txRow(app, win.id)).status).toBe('PROCESSED');
    expect(await balanceOf(app, w.id)).toBe('115.00');
    await expectLedgerInvariant(app, w.id);
  });
});

describe('referência inválida ou sem saldo', () => {
  test('referência chega mas termina REJECTED → REFERENCE_NOT_PROCESSED', async () => {
    const w = await openWallet(app, '10.00');
    const betInput = payload(w); // 25.00 > 10.00
    const refund = await submitted(app, referencing(w, betInput.externalTransactionId));
    expect((await submitted(app, betInput)).status).toBe('REJECTED');

    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });

    expect(await txRow(app, refund.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
      result_balance_amount: '10.00',
    });
    expect(await resolutionEvents(app, refund.id)).toEqual([
      { event_type: 'WagerTransactionRejected', correlation_id: refund.id, failure_code: 'REFERENCE_NOT_PROCESSED' },
    ]);
    expect(await ledgerOf(app, w.id)).toHaveLength(1);
    await expectLedgerInvariant(app, w.id);
  });

  test('referência já revertida → REFERENCE_ALREADY_REVERSED', async () => {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const rollback = await submitted(app, referencing(w, betInput.externalTransactionId, { kind: 'ROLLBACK' }));
    await submitted(app, betInput);
    expect((await submitted(app, referencing(w, betInput.externalTransactionId))).status).toBe('PROCESSED');

    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });

    expect(await txRow(app, rollback.id)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED' });
    expect(await ledgerOf(app, w.id)).toHaveLength(3); // abertura, BET, um único REFUND
    expect(await balanceOf(app, w.id)).toBe('100.00');
    await expectLedgerInvariant(app, w.id);
  });

  test('reversão resolvida que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const w = await openWallet(app, '10.00');
    const winInput = payload(w, { kind: 'WIN', money: brl('50.00') });
    const rollback = await submitted(app, referencing(w, winInput.externalTransactionId, { kind: 'ROLLBACK', money: brl('50.00') }));
    await submitted(app, winInput);
    await submitted(app, payload(w, { money: brl('50.00') })); // o WIN já foi gasto
    expect(await balanceOf(app, w.id)).toBe('10.00');

    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });

    expect(await txRow(app, rollback.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REVERSAL_INSUFFICIENT_FUNDS',
      result_balance_amount: '10.00',
    });
    expect(await balanceOf(app, w.id)).toBe('10.00');
    expect(await countRows(app, 'wallet_ledger_entries', 'transaction_id = ?', [rollback.id])).toBe(0);
    await expectLedgerInvariant(app, w.id);
  });
});

describe('referência ainda ausente', () => {
  test('backoff respeitado entre tentativas, sem evento novo', async () => {
    const w = await openWallet(app);
    const refund = await submitted(app, referencing(w, 'nunca-chega'));

    const started = Date.now();
    expect(await reprocess(app)).toMatchObject({ selected: 1, rescheduled: 1 });
    const first = await txRow(app, refund.id);
    expect(first).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    expect(first.next_reference_attempt_at!.getTime() - started).toBeGreaterThanOrEqual(1000);
    expect(first.next_reference_attempt_at!.getTime() - Date.now()).toBeLessThanOrEqual(1000);
    expect(await eventsOf(app, refund.id)).toEqual(['WagerTransactionPendingReference']);

    // rodada imediata: ainda em backoff, não é reavaliada
    expect(await reprocess(app)).toMatchObject({ selected: 0 });
    expect((await txRow(app, refund.id)).reference_attempts).toBe(1);

    await patchTx(app, refund.id, { next_reference_attempt_at: secondsAgo(1) });
    const again = Date.now();
    expect(await reprocess(app)).toMatchObject({ selected: 1, rescheduled: 1 });
    const second = await txRow(app, refund.id);
    expect(second.reference_attempts).toBe(2);
    expect(second.next_reference_attempt_at!.getTime() - again).toBeGreaterThanOrEqual(2000);
    expect(second.next_reference_attempt_at!.getTime() - Date.now()).toBeLessThanOrEqual(2000);
    expect(await eventsOf(app, refund.id)).toEqual(['WagerTransactionPendingReference']);
    await expectLedgerInvariant(app, w.id);
  });

  test('referência nunca chega → REJECTED com REFERENCE_NOT_FOUND após o TTL, com evento na outbox', async () => {
    const w = await openWallet(app, '100.00');
    const refund = await submitted(app, referencing(w, 'nunca-chega'));
    await patchTx(app, refund.id, { created_at: secondsAgo(TTL_SECONDS + 1) });

    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });

    expect(await txRow(app, refund.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      result_balance_amount: '100.00', // saldo atual da wallet
    });
    expect(await resolutionEvents(app, refund.id)).toEqual([
      { event_type: 'WagerTransactionRejected', correlation_id: refund.id, failure_code: 'REFERENCE_NOT_FOUND' },
    ]);
    expect(await balanceOf(app, w.id)).toBe('100.00');
    expect(await ledgerOf(app, w.id)).toHaveLength(1);
    await expectLedgerInvariant(app, w.id);
  });

  test('pouco antes do TTL ainda não rejeita', async () => {
    const w = await openWallet(app);
    const refund = await submitted(app, referencing(w, 'nunca-chega'));
    await patchTx(app, refund.id, { created_at: secondsAgo(TTL_SECONDS - 5) });

    expect(await reprocess(app)).toMatchObject({ selected: 1, rescheduled: 1 });
    expect((await txRow(app, refund.id)).status).toBe('PENDING_REFERENCE');
  });

  test('a rejeição por prazo acontece no TTL, não no fim do backoff de 5 min', async () => {
    const w = await openWallet(app);
    const refund = await submitted(app, referencing(w, 'nunca-chega'));
    // 10ª tentativa: o backoff sozinho agendaria para +300s; o prazo vence em 2s
    await patchTx(app, refund.id, { created_at: secondsAgo(TTL_SECONDS - 2), reference_attempts: 9 });

    expect(await reprocess(app)).toMatchObject({ selected: 1, rescheduled: 1 });
    const waiting = await txRow(app, refund.id);
    const deadline = waiting.created_at.getTime() + TTL_SECONDS * 1000;
    expect(waiting.reference_attempts).toBe(10);
    expect(waiting.next_reference_attempt_at!.getTime()).toBe(deadline);

    await Bun.sleep(Math.max(0, deadline - Date.now()) + 50);
    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });

    const rejected = await txRow(app, refund.id);
    expect(rejected).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(rejected.completed_at!.getTime() - deadline).toBeLessThan(1500);
    await expectLedgerInvariant(app, w.id);
  });

  test('referência aplicada depois do prazo e antes da reavaliação: vale a regra, PROCESSED', async () => {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const refund = await submitted(app, referencing(w, betInput.externalTransactionId));
    await patchTx(app, refund.id, { created_at: secondsAgo(TTL_SECONDS + 60) });
    await submitted(app, betInput);

    expect(await reprocess(app)).toMatchObject({ selected: 1, processed: 1 });
    expect((await txRow(app, refund.id)).status).toBe('PROCESSED');
    await expectLedgerInvariant(app, w.id);
  });

  test('cadeia ROLLBACK → REFUND → BET sem a BET: REFUND expira e o ROLLBACK é rejeitado sem esperar o backoff', async () => {
    const w = await openWallet(app, '100.00');
    const refundInput = referencing(w, 'bet-que-nunca-chega');
    const refund = await submitted(app, refundInput);
    const rollback = await submitted(app, referencing(w, refundInput.externalTransactionId, { kind: 'ROLLBACK' }));
    expect(rollback.status).toBe('PENDING_REFERENCE'); // a referência existe mas não finalizou
    await patchTx(app, rollback.id, { next_reference_attempt_at: IN_BACKOFF(), reference_attempts: 5 });
    await patchTx(app, refund.id, { created_at: secondsAgo(TTL_SECONDS + 1) });

    const first = await reprocess(app);
    expect(first).toMatchObject({ selected: 1, rejected: 1 });
    expect(first.outcomes as unknown[]).toEqual([
      { transactionId: refund.id, outcome: 'rejected', failureCode: 'REFERENCE_NOT_FOUND', attempts: 0 },
    ]);
    // a rejeição do REFUND antecipou o ROLLBACK que o aguardava
    const woken = await txRow(app, rollback.id);
    expect(woken).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 5 });
    expect(woken.next_reference_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());

    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });
    expect(await txRow(app, rollback.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
      reference_attempts: 5,
    });
    expect(await balanceOf(app, w.id)).toBe('100.00');
    expect(await ledgerOf(app, w.id)).toHaveLength(1);
    await expectLedgerInvariant(app, w.id);
  });
});

describe('antecipação ao gravar a referência', () => {
  async function refundInBackoff(balance: string) {
    const w = await openWallet(app, balance);
    const betInput = payload(w);
    const refund = await submitted(app, referencing(w, betInput.externalTransactionId));
    const until = IN_BACKOFF();
    await patchTx(app, refund.id, { next_reference_attempt_at: until, reference_attempts: 3 });
    return { w, betInput, refund, until };
  }

  test.each([
    ['aplicada', '100.00', 'PROCESSED'],
    ['rejeitada', '10.00', 'REJECTED'],
  ])('BET %s torna vencido o REFUND em backoff, sem resolvê-lo nem contar tentativa', async (_name, balance, betStatus) => {
    const { betInput, refund } = await refundInBackoff(balance);

    const before = Date.now();
    expect((await submitted(app, betInput)).status).toBe(betStatus);

    const row = await txRow(app, refund.id);
    expect(row).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 3 });
    expect(row.next_reference_attempt_at!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.next_reference_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('pendente de outra referência ou de outro provider não é antecipada', async () => {
    const { w, betInput, refund: sameProvider, until } = await refundInBackoff('100.00');
    const otherProvider = await submitted(app, referencing(w, betInput.externalTransactionId, { providerId: 'provider-b' }));
    await patchTx(app, otherProvider.id, { next_reference_attempt_at: until });
    const otherReference = await submitted(app, referencing(w, 'outra-referencia'));
    await patchTx(app, otherReference.id, { next_reference_attempt_at: until });

    await submitted(app, betInput);

    expect((await txRow(app, sameProvider.id)).next_reference_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await txRow(app, otherProvider.id)).next_reference_attempt_at).toEqual(until);
    expect((await txRow(app, otherReference.id)).next_reference_attempt_at).toEqual(until);
  });

  test('falha antes do commit desfaz a antecipação', async () => {
    const { w, betInput, refund, until } = await refundInBackoff('100.00');

    await expect(submit(flaky, betInput)).rejects.toThrow('processo caiu antes do commit');

    expect((await txRow(app, refund.id)).next_reference_attempt_at).toEqual(until);
    expect(await balanceOf(app, w.id)).toBe('100.00');
  });
});

test('falha no meio da gravação do desfecho: nada muda e a rodada seguinte resolve', async () => {
  const instance = await boot({}, failFirstOutboxAdd);
  try {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const refund = await submitted(app, referencing(w, betInput.externalTransactionId));
    await submitted(app, betInput);

    const failed = await reprocess(instance);
    expect(failed).toMatchObject({ selected: 1, failed: 1, processed: 0 });
    expect(failed.outcomes[0]).toMatchObject({ transactionId: refund.id, outcome: 'failed', error: 'processo caiu antes do commit' });
    expect(await txRow(app, refund.id)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 0 });
    expect(await balanceOf(app, w.id)).toBe('75.00');
    expect(await ledgerOf(app, w.id)).toHaveLength(2);
    expect(await resolutionEvents(app, refund.id)).toEqual([]);

    expect(await reprocess(instance)).toMatchObject({ selected: 1, processed: 1 });
    expect(await balanceOf(app, w.id)).toBe('100.00');
    await expectLedgerInvariant(app, w.id);
  } finally {
    await instance.close();
  }
});

describe('concorrência', () => {
  /** `count` REFUNDs pendentes cuja BET já foi aplicada. */
  async function resolvable(w: Awaited<ReturnType<typeof openWallet>>, count: number) {
    const refunds: string[] = [];
    for (let i = 0; i < count; i++) {
      const betInput = payload(w, { money: brl('1.00') });
      refunds.push((await submitted(app, referencing(w, betInput.externalTransactionId, { money: brl('1.00') }))).id);
      await submitted(app, betInput);
    }
    return refunds;
  }

  async function expectAppliedOnce(refunds: string[]) {
    for (const id of refunds) {
      expect((await txRow(app, id)).status).toBe('PROCESSED');
      expect(await countRows(app, 'wallet_ledger_entries', 'transaction_id = ?', [id])).toBe(1);
      expect((await resolutionEvents(app, id)).map((e) => e.event_type)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    }
  }

  test('dois workers concorrentes: cada pendente processada uma única vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet(app, '100.00')));
    const refunds = (await Promise.all(wallets.map((w) => resolvable(w, 6)))).flat();

    const totals = await Promise.all([drainPending(app), drainPending(other)]);

    expect(totals.map((t) => t.failed)).toEqual([0, 0]);
    expect(totals[0]!.processed + totals[1]!.processed).toBe(refunds.length);
    expect(totals[0]!.rejected + totals[1]!.rejected + totals[0]!.rescheduled + totals[1]!.rescheduled).toBe(0);
    await expectAppliedOnce(refunds);
    for (const w of wallets) {
      expect(await balanceOf(app, w.id)).toBe('100.00');
      await expectLedgerInvariant(app, w.id);
    }
  }, 30_000);

  test('worker concorrendo com novas BETs na mesma wallet: sem deadlock, invariante preservada', async () => {
    const w = await openWallet(app, '100.00');
    const refunds = await resolvable(w, 12);

    const settled = await Promise.allSettled([
      drainPending(app),
      drainPending(other),
      ...Array.from({ length: 30 }, () => submit(app, payload(w, { money: brl('1.00') }))),
    ]);

    // allSettled: deadlock ou lock_timeout apareceria aqui como rejeição
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    const [a, b] = settled.slice(0, 2).map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof drainPending>>>).value);
    expect([a!.failed, b!.failed]).toEqual([0, 0]);
    await expectAppliedOnce(refunds);
    expect(await balanceOf(app, w.id)).toBe('70.00');
    await expectLedgerInvariant(app, w.id);
  }, 30_000);

  // Corrida da antecipação: a BET é gravada enquanto os workers reavaliam o REFUND que a aguarda.
  // Qualquer que seja a ordem, o REFUND sai da corrida aplicado ou vencido — nunca preso em backoff.
  test('use case grava a referência enquanto o worker reavalia a pendente: resolvida, sem deadlock', async () => {
    const cases = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const w = await openWallet(app, '100.00');
        const betInput = payload(w);
        const refund = await submitted(app, referencing(w, betInput.externalTransactionId));
        return { w, betInput, refund };
      }),
    );

    const settled = await Promise.allSettled([
      ...cases.map((c) => submit(app, c.betInput)),
      reprocess(app),
      reprocess(other),
    ]);

    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    for (const s of settled.slice(-2)) {
      expect((s as PromiseFulfilledResult<Awaited<ReturnType<typeof reprocess>>>).value.failed).toBe(0);
    }
    for (const { refund } of cases) {
      const row = await txRow(app, refund.id);
      if (row.status === 'PROCESSED') continue;
      // o worker passou antes do commit da BET e reagendou; a BET antecipou de volta
      expect(row.status).toBe('PENDING_REFERENCE');
      expect(row.next_reference_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    }

    expect((await drainPending(app)).failed).toBe(0);
    for (const { w, refund } of cases) {
      expect((await txRow(app, refund.id)).status).toBe('PROCESSED');
      expect(await countRows(app, 'wallet_ledger_entries', 'transaction_id = ?', [refund.id])).toBe(1);
      expect(await balanceOf(app, w.id)).toBe('100.00');
      await expectLedgerInvariant(app, w.id);
    }
  }, 30_000);
});

describe('replay de pendente resolvida (mesma Idempotency-Key)', () => {
  async function post(input: ReturnType<typeof payload>) {
    const { idempotencyKey, ...body } = input;
    const res = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test('HTTP: 202 enquanto pendente; depois de aplicada pelo worker, 200 PROCESSED com o saldo da resolução', async () => {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const refundInput = referencing(w, betInput.externalTransactionId);

    const first = await post(refundInput);
    expect([first.status, first.body.status]).toEqual([202, 'PENDING_REFERENCE']);
    expect((await post(betInput)).status).toBe(201);
    expect(await reprocess(app)).toMatchObject({ selected: 1, processed: 1 });
    await submitted(app, payload(w, { money: brl('30.00') })); // o saldo muda depois da resolução
    const outboxBefore = await countRows(app, 'outbox_messages', '1 = 1', []);

    const replay = await post(refundInput);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    expect(await balanceOf(app, w.id)).toBe('70.00');
    expect(await ledgerOf(app, w.id)).toHaveLength(4); // abertura, BET, REFUND, BET — o replay não grava
    expect(await countRows(app, 'outbox_messages', '1 = 1', [])).toBe(outboxBefore);
    await expectLedgerInvariant(app, w.id);
  });

  test('HTTP: depois de expirar, 422 REJECTED com REFERENCE_NOT_FOUND, não 202', async () => {
    const w = await openWallet(app, '100.00');
    const refundInput = referencing(w, 'nunca-chega');
    const first = await post(refundInput);
    expect(first.status).toBe(202);
    await patchTx(app, first.body.transactionId as string, { created_at: secondsAgo(TTL_SECONDS + 1) });
    expect(await reprocess(app)).toMatchObject({ selected: 1, rejected: 1 });

    const replay = await post(refundInput);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    await expectLedgerInvariant(app, w.id);
  });

  test('use case: replay devolve a transação terminal', async () => {
    const w = await openWallet(app, '100.00');
    const betInput = payload(w);
    const refundInput = referencing(w, betInput.externalTransactionId);
    const refund = await submitted(app, refundInput);
    await submitted(app, betInput);
    await reprocess(app);

    const replay = await submit(app, refundInput);

    if (replay.outcome !== 'replay') throw new Error(replay.outcome);
    expect(replay.transaction.id).toBe(refund.id);
    expect(replay.transaction.status).toBe('PROCESSED');
    expect(replay.transaction.resultBalance!.toJSON()).toEqual(brl('100.00'));
    await expectLedgerInvariant(app, w.id);
  });
});
