import { afterAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { balanceOf, boot, countRows, expectLedgerInvariant, ledgerOf, openWallet, payload } from './application/helpers';
import { DLQ, MAIN, depth, envelope, mainEmpty, quiesce as quiesceQueues, send, waitFor } from './consumer/helpers';
import { drain as drainEvents, pendingRows, quiesce as quiesceOutbox } from './outbox/helpers';
import { quiescePending } from './pending-reference/helpers';
import { sql } from './persistence/helpers';
import { spawnInstance, type Instance } from './process';

// CHALLENGE §13, Concorrência, item 8. Processos reais (`bun src/main.ts`), nenhum gancho de teste
// no código de produção. `admin` só consulta o banco: os workers dele ficam desligados (test/setup.ts).
const admin = await boot();
afterAll(() => admin.close());

/** A mesma configuração para a instância que morre e para a que assume. */
const ENV = {
  SQS_CONSUMER_ENABLED: 'true',
  SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
  OUTBOX_PUBLISHER_ENABLED: 'true',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_WORKER_ENABLED: 'true',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
  DB_LOCK_TIMEOUT_MS: '1000',
  SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '8', // o que estava em voo no SIGKILL reaparece em 8s, não em 30
};

// Carga por wallet. O saldo de abertura comporta qualquer ordem de processamento, cada referência
// tem uma única reversão e nenhuma reversão referencia outra: tudo termina PROCESSED e o saldo
// final é exato, por mais que a ordem varie.
const WALLETS = 4;
const OPENING = '10000.00';
const BETS = 30; // 25.00 cada (padrão do payload)
const WINS = 10;
const WIN = '40.00';
const REFUNDED_BETS = 8; // BETs 0–7
const ROLLED_BACK_BETS = 6; // BETs 8–13
const ROLLED_BACK_WINS = 4; // WINs 0–3
const PER_WALLET = BETS + WINS + REFUNDED_BETS + ROLLED_BACK_BETS + ROLLED_BACK_WINS; // 58
const TOTAL = WALLETS * PER_WALLET; // 232
// 10000.00 − 30×25.00 + 10×40.00 + 8×25.00 + 6×25.00 − 4×40.00
const FINAL_BALANCE = '9840.00';
const DEBITS = BETS + ROLLED_BACK_WINS; // 34
const CREDITS = 1 + WINS + REFUNDED_BETS + ROLLED_BACK_BETS; // 25, com a abertura

type Op = ReturnType<typeof payload>;

function loadFor(wallet: Parameters<typeof payload>[0]): Op[] {
  const bets = Array.from({ length: BETS }, () => payload(wallet));
  const wins = Array.from({ length: WINS }, () => payload(wallet, { kind: 'WIN', money: { amount: WIN, currency: 'BRL' } }));
  const reversal = (kind: string, target: Op) =>
    payload(wallet, { kind, money: target.money, referenceExternalTransactionId: target.externalTransactionId });
  return [
    ...bets,
    ...wins,
    ...bets.slice(0, REFUNDED_BETS).map((bet) => reversal('REFUND', bet)),
    ...bets.slice(REFUNDED_BETS, REFUNDED_BETS + ROLLED_BACK_BETS).map((bet) => reversal('ROLLBACK', bet)),
    ...wins.slice(0, ROLLED_BACK_WINS).map((win) => reversal('ROLLBACK', win)),
  ];
}

async function post(base: string, { idempotencyKey, ...body }: Op) {
  const res = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test('reinício do serviço: SIGKILL no meio de carga mista (HTTP e fila), nova instância assume e o estado final é consistente', async () => {
  // banco e filas são compartilhados: sem isso, publisher e worker de pendentes pegariam sobras de outras suítes
  await quiesceQueues();
  await quiesceOutbox(admin);
  await quiescePending(admin);

  const wallets = await Promise.all(Array.from({ length: WALLETS }, () => openWallet(admin, OPENING)));
  const walletIds = wallets.map((w) => w.id);
  const inWallets = `wallet_id in (${walletIds.map(() => '?').join(', ')})`;
  const loads = wallets.map(loadFor);

  // Reversão antes da referência, garantida: o REFUND da BET 0 (wallet 0) e o ROLLBACK do WIN 0
  // (wallet 1) são aceitos como pendentes pela instância A; as referências só entram na fila depois
  // do SIGKILL. A instância B é obrigada a consumir, resolver a pendente e publicar.
  const held = [loads[0]![0]!, loads[1]![BETS]!];
  const early = [loads[0]![BETS + WINS]!, loads[1]![BETS + WINS + REFUNDED_BETS + ROLLED_BACK_BETS]!];

  // índice par → fila, ímpar → HTTP: referência e reversão caem com frequência em canais diferentes
  const byQueue: Op[] = [];
  const byHttp: Op[] = [];
  for (const load of loads) {
    load.forEach((op, i) => {
      if (!held.includes(op) && !early.includes(op)) (i % 2 === 0 ? byQueue : byHttp).push(op);
    });
  }
  const queued = byQueue.map((op) => envelope(op));
  const heldMessages = held.map((op) => envelope(op));

  const committed = () => countRows(admin, 'wager_transactions', `${inWallets} and kind <> 'OPENING'`, walletIds);

  // a carga da fila já está inteira lá quando o consumidor começa; grupo aleatório por mensagem,
  // então o broker não ordena nada
  await Promise.all(queued.map((message) => send(message)));

  const instances: Instance[] = [];
  try {
    const a = await spawnInstance(ENV);
    instances.push(a);
    const earlyAnswers = [];
    for (const op of early) {
      const answer = await post(a.base, op);
      expect(answer).toMatchObject({ status: 202, body: { status: 'PENDING_REFERENCE' } });
      earlyAnswers.push(answer);
    }
    const inFlight = byHttp.map((op) => post(a.base, op).catch(() => undefined)); // conexão cortada = sem resposta

    await waitFor(async () => (await committed()) >= TOTAL / 4, 30_000);
    a.proc.kill('SIGKILL');
    await a.proc.exited;
    const answersFromA = [...earlyAnswers, ...(await Promise.all(inFlight))];

    // a queda foi de fato no meio da carga; se a máquina terminar tudo antes, aumente as constantes
    expect(await committed()).toBeLessThan(TOTAL);
    expect(await depth(MAIN)).toBeGreaterThan(0);

    await Promise.all(heldMessages.map((message) => send(message)));
    const b = await spawnInstance(ENV);
    instances.push(b);

    // o provedor que perdeu a conexão reenvia tudo com a mesma Idempotency-Key
    for (const [i, op] of [...early, ...byHttp].entries()) {
      const again = await post(b.base, op);
      expect([200, 201, 202]).toContain(again.status);
      const before = answersFromA[i]?.body.transactionId;
      if (before) expect(again.body).toMatchObject({ transactionId: before, idempotentReplay: true });
    }

    // Nesta ordem (as leituras não são atômicas entre si): fila vazia ⇒ toda referência confirmada
    // ⇒ quem a aguardava ficou vencida na mesma transação; sem pendente vencida ⇒ os eventos de
    // resolução já estão na outbox; só então outbox vazia quer dizer "tudo publicado".
    await waitFor(
      async () =>
        (await mainEmpty()) &&
        (await countRows(admin, 'wager_transactions', `${inWallets} and status = 'PENDING_REFERENCE' and next_reference_attempt_at <= now()`, walletIds)) === 0 &&
        (await pendingRows(admin)).length === 0,
      60_000,
    );

    for (const id of walletIds) {
      const res = await fetch(`${b.base}/wallets/${id}/reconciliation`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ consistent: true, difference: { amount: '0.00' }, checkedEntries: DEBITS + CREDITS });
    }
    b.proc.kill('SIGTERM'); // a fila de eventos para de mudar antes de ser drenada
    await b.proc.exited;
  } finally {
    for (const instance of instances) if (instance.proc.exitCode === null) instance.proc.kill('SIGKILL');
  }

  const orm: MikroORM = admin.get(MikroORM);

  // nada ficou para trás e nenhuma operação virou duas transações
  const transactions = await sql<{ id: string; status: string; provider_id: string; idempotency_key: string; external_transaction_id: string; reference_transaction_id: string | null }>(
    orm,
    `select id, status, provider_id, idempotency_key, external_transaction_id, reference_transaction_id
       from wager_transactions where ${inWallets} and kind <> 'OPENING'`,
    walletIds,
  );
  expect(transactions).toHaveLength(TOTAL);
  expect(transactions.filter((t) => t.status !== 'PROCESSED')).toEqual([]);
  expect(new Set(transactions.map((t) => `${t.provider_id}:${t.idempotency_key}`)).size).toBe(TOTAL);
  expect(transactions.map((t) => t.idempotency_key).sort()).toEqual(loads.flat().map((op) => op.idempotencyKey).sort());
  for (const op of early) {
    const reversal = transactions.find((t) => t.external_transaction_id === op.externalTransactionId)!;
    expect(reversal.reference_transaction_id).not.toBeNull();
  }
  expect(await depth(DLQ)).toBe(0);

  // saldo exato, invariante final e um único lançamento por transação
  for (const id of walletIds) {
    expect(await balanceOf(admin, id)).toBe(FINAL_BALANCE);
    await expectLedgerInvariant(admin, id);
    const ledger = await ledgerOf(admin, id);
    expect(new Set(ledger.map((entry) => entry.transaction_id)).size).toBe(ledger.length);
    expect(ledger.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(DEBITS);
    expect(ledger.filter((entry) => entry.direction === 'CREDIT')).toHaveLength(CREDITS);
  }

  // inbox: uma linha por mensagem, mesmo as reentregues depois da queda
  const messageIds = [...queued, ...heldMessages].map((message) => message.messageId);
  const inbox = await sql<{ message_id: string }>(
    orm,
    `select message_id from inbox_messages where message_id in (${messageIds.map(() => '?').join(', ')})`,
    messageIds,
  );
  expect(inbox.map((row) => row.message_id).sort()).toEqual([...messageIds].sort());

  // todo evento confirmado foi publicado: nenhum perdido na outbox, nenhum em dobro, todos na fila de eventos
  const events = await sql<{ id: string; event_type: string; aggregate_id: string; transaction_id: string | null; published_at: string | null }>(
    orm,
    `select id, event_type, aggregate_id, payload->'data'->>'transactionId' as transaction_id, published_at
       from outbox_messages
      where aggregate_id::text in (${walletIds.map(() => '?').join(', ')})
         or aggregate_id::text in (select id::text from wager_transactions where ${inWallets} and kind <> 'OPENING')`,
    [...walletIds, ...walletIds],
  );
  expect(events.filter((event) => event.published_at === null)).toEqual([]);
  const transactionIds = transactions.map((t) => t.id).sort();
  expect(events.filter((e) => e.event_type === 'WagerTransactionProcessed').map((e) => e.aggregate_id).sort()).toEqual(transactionIds);
  // (o lançamento de abertura é anterior ao cenário e fica de fora)
  expect(
    events
      .filter((e) => e.event_type === 'WalletBalanceChanged' && transactionIds.includes(e.transaction_id!))
      .map((e) => e.transaction_id!)
      .sort(),
  ).toEqual(transactionIds);
  // inclusão, não contagem: a entrega é at-least-once
  const delivered = new Set((await drainEvents()).map((message) => message.body.eventId));
  expect(events.filter((event) => !delivered.has(event.id)).map((event) => event.event_type)).toEqual([]);
}, 120_000);
