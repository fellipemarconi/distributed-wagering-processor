// Teste de carga (CHALLENGE §14): `bun run test:load`. Não é `*.test.ts`, então o `bun test` não o coleta.
// Metodologia, resultados e análise: LOAD_TEST.md.
import './setup'; // banco de testes, infra verificada e migrations aplicadas
import os from 'node:os';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, PurgeQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config';
import { createSqsClient } from '../src/infra/sqs.provider';
import { ormOptions } from '../src/mikro-orm.config';
import { spawnInstance, type Instance } from './process';

// ---- parâmetros

const SCENARIOS = ['mixed', 'hot', 'replay', 'sqs'] as const;
type Scenario = (typeof SCENARIOS)[number];

function num(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    console.error(`Parâmetro inválido: ${name}="${process.env[name]}"`);
    process.exit(2);
  }
  return value;
}

const selected = (process.env.LOAD_SCENARIOS ?? SCENARIOS.join(',')).split(',').map((s) => s.trim()) as Scenario[];
const unknown = selected.filter((s) => !SCENARIOS.includes(s));
if (unknown.length > 0) {
  console.error(`Parâmetro inválido: LOAD_SCENARIOS contém "${unknown.join(', ')}" (use ${SCENARIOS.join(' | ')})`);
  process.exit(2);
}
const DURATION_S = num('LOAD_DURATION_S', 20);
const WARMUP_S = num('LOAD_WARMUP_S', 5);
const RATE = num('LOAD_RATE', 100);
const WALLETS = Math.round(num('LOAD_WALLETS', 200));
const REPLAY_FRACTION = num('LOAD_REPLAY_FRACTION', 0.3, 1);
const TIMEOUT_MS = num('LOAD_TIMEOUT_MS', 10_000);
const plan = selected.map((name) => ({
  name,
  rate: num(`LOAD_${name.toUpperCase()}_RATE`, RATE),
  duration: num(`LOAD_${name.toUpperCase()}_DURATION_S`, DURATION_S),
}));

/** Padrão da aplicação, exceto log (o pipe de logs competiria com o gerador) e long polling (encerramento rápido). */
const ENV = {
  LOG_LEVEL: 'warn',
  SQS_CONSUMER_ENABLED: 'true',
  OUTBOX_PUBLISHER_ENABLED: 'true',
  PENDING_REFERENCE_WORKER_ENABLED: 'true',
  SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
};
const INSTANCES = 3;
const DRAIN_LIMIT_MS = 120_000;
const REPLAY_WINDOW = 50;

// ---- infra

const config = loadConfig();
const sqs = createSqsClient(config);
const orm = await MikroORM.init({ ...ormOptions(config), logger: () => {} });
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
  orm.em.getDriver().getConnection().execute(text, params);
const urlOf = async (QueueName: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
const MAIN = await urlOf(config.sqsQueueName);
const DLQ = await urlOf(config.sqsDlqName);
const EVENTS = await urlOf(config.outboxQueueName);

/** Mensagens visíveis + em voo. */
async function depth(QueueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
  );
  return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

const pendingOutbox = async () =>
  Number((await sql<{ n: string }>('select count(*) as n from outbox_messages where published_at is null'))[0]!.n);

// ---- métricas

type Metrics = Map<string, number>;

/** Soma, por série, o /metrics de todas as instâncias (os contadores são por instância). */
async function scrape(instances: Instance[]): Promise<Metrics> {
  const total: Metrics = new Map();
  for (const instance of instances) {
    const text = await (await fetch(`${instance.base}/metrics`)).text();
    for (const line of text.split('\n')) {
      const match = /^(\w+(?:\{[^}]*\})?) (\S+)$/.exec(line);
      if (match) total.set(match[1]!, (total.get(match[1]!) ?? 0) + Number(match[2]));
    }
  }
  return total;
}

/** Variação de uma métrica entre dois scrapes, agrupada pelo valor de `label` (ou total, sem label). */
function delta(before: Metrics, after: Metrics, name: string, label?: string, filter = ''): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const [series, value] of after) {
    if (series !== name && !series.startsWith(`${name}{`)) continue;
    if (!series.includes(filter)) continue;
    const diff = value - (before.get(series) ?? 0);
    if (diff === 0) continue;
    const key = label ? (new RegExp(`${label}="([^"]*)"`).exec(series)?.[1] ?? '?') : 'total';
    groups[key] = (groups[key] ?? 0) + diff;
  }
  return groups;
}

const total = (groups: Record<string, number>) => Object.values(groups).reduce((a, b) => a + b, 0);
const show = (groups: Record<string, number>) =>
  Object.entries(groups).sort().map(([k, v]) => `${k}=${v}`).join(' ') || '0';

// ---- gerador open-loop

interface Sample {
  status: string;
  latencyMs: number;
  /** Atraso do próprio gerador: disparo real − instante agendado. */
  lateMs: number;
}

/**
 * Taxa de chegada constante: a requisição i é agendada para `início + i/taxa` e disparada sem esperar
 * as anteriores. A latência conta do instante agendado, não do envio — se o gerador ou o servidor
 * atrasarem, o atraso aparece na medida em vez de sumir (coordinated omission).
 */
// ponytail: sem teto de requisições em voo; com taxa muito acima da capacidade elas se acumulam até o
// timeout. Teto com descarte contabilizado se for preciso medir saturação pesada.
async function openLoop(rate: number, seconds: number, fire: (i: number, scheduled: number) => Promise<string>) {
  const interval = 1000 / rate;
  const count = Math.round(rate * seconds);
  const samples: Sample[] = [];
  const inFlight: Promise<void>[] = [];
  const start = performance.now();
  let lastEnd = start;
  for (let i = 0; i < count; ) {
    while (i < count && start + i * interval <= performance.now()) {
      const scheduled = start + i * interval;
      const lateMs = performance.now() - scheduled;
      inFlight.push(
        fire(i++, scheduled)
          .catch((error: Error) => (error.name === 'TimeoutError' ? 'timeout' : 'erro'))
          .then((status) => {
            lastEnd = performance.now();
            samples.push({ status, latencyMs: lastEnd - scheduled, lateMs });
          }),
      );
    }
    await Bun.sleep(1);
  }
  await Promise.all(inFlight);
  return { samples, seconds: (lastEnd - start) / 1000 };
}

/** Percentis nearest-rank sobre o vetor ordenado. */
function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted.at(-1) ?? 0 };
}

// ---- carga

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallets(base: string, balances: string[]): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let i = 0; i < balances.length; i += 20) {
    wallets.push(
      ...(await Promise.all(
        balances.slice(i, i + 20).map(async (amount) => {
          const res = await fetch(`${base}/wallets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: 'BRL' } }),
          });
          if (res.status !== 201) throw new Error(`POST /wallets respondeu ${res.status}`);
          return (await res.json()) as Wallet;
        }),
      )),
    );
  }
  return wallets;
}

const KINDS = ['BET', 'BET', 'BET', 'WIN', 'LOSS']; // 60% / 20% / 20%, pelo índice da requisição
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

function operation(wallet: Wallet, i: number) {
  const kind = KINDS[i % KINDS.length]!;
  const externalTransactionId = Bun.randomUUIDv7();
  return {
    idempotencyKey: `load:${externalTransactionId}`,
    providerId: 'load',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-load',
    gameId: 'load-test',
    kind,
    money: { amount: kind === 'WIN' ? '40.00' : '25.00', currency: 'BRL' },
  };
}
type Operation = ReturnType<typeof operation>;

async function post(base: string, { idempotencyKey, ...body }: Operation) {
  const res = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { transactionId?: string } };
}

/** Envelope da seção 10 do CHALLENGE.md; grupo = wallet, como o README recomenda. */
async function enqueue(op: Operation): Promise<void> {
  const messageId = `msg-${op.externalTransactionId}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: MAIN,
      MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: op }),
      MessageGroupId: op.walletId,
      MessageDeduplicationId: messageId,
    }),
  );
}

// ---- cenário

const DEFINITIVE = [200, 201, 202, 422]; // a transação existe; os demais status não dizem se houve commit

async function run({ name, rate, duration }: (typeof plan)[number], instances: Instance[]) {
  console.log(`\n[${name}] ${rate} req/s por ${duration}s (+${WARMUP_S}s de aquecimento)`);
  const failures: string[] = [];
  const balances =
    name === 'hot'
      ? ['10000000.00']
      : // no `mixed`, 10% das wallets abrem quase vazias: INSUFFICIENT_FUNDS (422) aparece sem ser forçado
        Array.from({ length: WALLETS }, (_, i) => (name === 'mixed' && i % 10 === 0 ? '50.00' : '100000.00'));
  const wallets = await openWallets(instances[0]!.base, balances);

  const sentKeys = new Set<string>();
  const definitiveKeys = new Set<string>();
  const transactionIds = new Map<string, string>();
  const recent: Operation[] = [];
  const queuedAt = new Map<string, number>(); // externalTransactionId → instante agendado (epoch ms)
  let measuring = false;

  const fire = async (i: number, scheduled: number): Promise<string> => {
    const replay = name === 'replay' && recent.length > 0 && Math.random() < REPLAY_FRACTION;
    const op = replay ? pick(recent) : operation(pick(wallets), i);
    if (!replay) {
      recent.push(op);
      if (recent.length > REPLAY_WINDOW) recent.shift();
    }
    sentKeys.add(op.idempotencyKey);
    if (name === 'sqs' && i % 2 === 1) {
      await enqueue(op);
      definitiveKeys.add(op.idempotencyKey);
      if (measuring) queuedAt.set(op.externalTransactionId, performance.timeOrigin + scheduled);
      return 'sqs';
    }
    const { status, body } = await post(instances[i % instances.length]!.base, op);
    if (DEFINITIVE.includes(status)) {
      definitiveKeys.add(op.idempotencyKey);
      const seen = transactionIds.get(op.idempotencyKey);
      if (seen && seen !== body.transactionId) failures.push(`chave ${op.idempotencyKey} respondeu com dois transactionId`);
      if (body.transactionId) transactionIds.set(op.idempotencyKey, body.transactionId);
    }
    return String(status);
  };

  await openLoop(rate, WARMUP_S, fire); // amostras descartadas
  const before = await scrape(instances);
  measuring = true;

  // o gauge lê o banco, então uma instância basta
  let outboxMaxAge = 0;
  const sampler = setInterval(async () => {
    const metrics = await scrape([instances[0]!]).catch(() => undefined);
    outboxMaxAge = Math.max(outboxMaxAge, metrics?.get('wagering_outbox_oldest_pending_age_seconds') ?? 0);
  }, 1000);

  const load = await openLoop(rate, duration, fire);

  const drainStart = performance.now();
  let drained = true;
  while ((await depth(MAIN)) > 0 || (await pendingOutbox()) > 0) {
    if (performance.now() - drainStart > DRAIN_LIMIT_MS) {
      drained = false;
      failures.push(`fila principal ou outbox não esvaziaram em ${DRAIN_LIMIT_MS / 1000}s`);
      break;
    }
    await Bun.sleep(100);
  }
  const drainSeconds = (performance.now() - drainStart) / 1000;
  clearInterval(sampler);
  const after = await scrape(instances); // depois da drenagem: inclui o que entrou pela fila e todas as publicações

  // ---- verificação de correção, restrita às wallets do cenário. Dinheiro só é comparado no banco (numeric).
  const ids = wallets.map((w) => w.id);
  const inWallets = `wallet_id in (${ids.map(() => '?').join(', ')})`;
  const count = async (query: string) => Number((await sql<{ n: string }>(`select count(*) as n from ${query}`, ids))[0]!.n);

  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(
      ids.slice(i, i + 20).map(async (id) => {
        const res = await fetch(`${instances[0]!.base}/wallets/${id}/reconciliation`, { method: 'POST' });
        const body = (await res.json()) as { consistent?: boolean; chainIntact?: boolean };
        if (res.status !== 200 || body.consistent !== true || body.chainIntact !== true) {
          failures.push(`reconciliação da wallet ${id}: ${res.status} ${JSON.stringify(body)}`);
        }
      }),
    );
  }

  // saldo = abertura ± transações aplicadas, a partir de wager_transactions: independe do ledger, então
  // acusa débito em dobro mesmo que ledger e saldo concordem entre si
  const wrongBalance = await sql<{ id: string }>(
    `select w.id from wallets w
      where w.id in (${ids.map(() => '?').join(', ')})
        and w.balance <> (select coalesce(sum(case t.kind when 'BET' then -t.amount when 'LOSS' then 0 else t.amount end), 0)
                            from wager_transactions t where t.wallet_id = w.id and t.status = 'PROCESSED')`,
    ids,
  );
  if (wrongBalance.length > 0) failures.push(`saldo ≠ abertura ± transações PROCESSED em ${wrongBalance.length} wallet(s): ${wrongBalance[0]!.id}`);

  const duplicatedKeys = await count(
    `(select 1 from wager_transactions where ${inWallets} group by provider_id, idempotency_key having count(*) > 1) d`,
  );
  if (duplicatedKeys > 0) failures.push(`${duplicatedKeys} idempotency key(s) com mais de uma transação`);

  const transactions = await count(`wager_transactions where ${inWallets} and kind <> 'OPENING'`);
  if (transactions < definitiveKeys.size || transactions > sentKeys.size) {
    failures.push(`${transactions} transações gravadas; esperado entre ${definitiveKeys.size} (confirmadas) e ${sentKeys.size} (enviadas)`);
  }

  const duplicatedEntries = await count(
    `(select 1 from wallet_ledger_entries where ${inWallets} group by transaction_id having count(*) > 1) d`,
  );
  if (duplicatedEntries > 0) failures.push(`${duplicatedEntries} transação(ões) com mais de um lançamento`);

  const entries = await count(`wallet_ledger_entries where ${inWallets}`);
  const moving = await count(`wager_transactions where ${inWallets} and status = 'PROCESSED' and kind <> 'LOSS'`);
  if (entries !== moving) failures.push(`${entries} lançamentos para ${moving} transações aplicadas que movimentam saldo`);

  if (drained) {
    const open = await count(`wager_transactions where ${inWallets} and status not in ('PROCESSED', 'REJECTED')`);
    if (open > 0) failures.push(`${open} transação(ões) em estado não terminal depois da drenagem`);
  }

  let queue: { sent: number; latency: ReturnType<typeof percentiles>; serverMeanMs: number } | undefined;
  if (name === 'sqs') {
    const dlq = await depth(DLQ);
    if (dlq > 0) failures.push(`${dlq} mensagem(ns) na DLQ`);
    // ponta a ponta da fila: do instante agendado do envio até o completed_at gravado pela aplicação
    const rows = await sql<{ external_transaction_id: string; completed_at: string | null }>(
      `select external_transaction_id, completed_at from wager_transactions where ${inWallets} and kind <> 'OPENING'`,
      ids,
    );
    const latencies = rows.flatMap((row) => {
      const scheduled = queuedAt.get(row.external_transaction_id);
      return scheduled !== undefined && row.completed_at ? [new Date(row.completed_at).getTime() - scheduled] : [];
    });
    queue = { sent: queuedAt.size, latency: percentiles(latencies), serverMeanMs: meanMs(before, after, 'wagering_processing_duration_seconds', 'channel="sqs"') };
  }

  const http = load.samples.filter((s) => s.status !== 'sqs');
  const statuses: Record<string, number> = {};
  for (const s of http) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  const result = {
    name,
    rate,
    duration,
    wallets: wallets.length,
    sent: load.samples.length,
    throughput: http.filter((s) => /^\d/.test(s.status)).length / load.seconds, // timeout e erro não são resposta
    latency: percentiles(http.map((s) => s.latencyMs)),
    late: percentiles(load.samples.map((s) => s.lateMs)),
    statuses,
    serverMeanMs: meanMs(before, after, 'wagering_processing_duration_seconds', 'channel="http"'),
    lockConflicts: delta(before, after, 'wagering_lock_conflicts_total', 'type'),
    retries: delta(before, after, 'wagering_retries_total', 'source'),
    duplicates: delta(before, after, 'wagering_duplicates_total', 'type'),
    outboxMaxAge,
    publishLagMeanMs: meanMs(before, after, 'wagering_outbox_publish_lag_seconds'),
    drainSeconds,
    queue,
    failures,
  };
  console.log(
    `[${name}] ${result.throughput.toFixed(1)} resp/s · p50 ${ms(result.latency.p50)} p95 ${ms(result.latency.p95)} p99 ${ms(result.latency.p99)} max ${ms(result.latency.max)} ms · ${show(statuses)}`,
  );
  console.log(failures.length === 0 ? `[${name}] verificação de correção: ok` : `[${name}] FALHAS DE VERIFICAÇÃO:\n  - ${failures.join('\n  - ')}`);
  return result;
}
type Result = Awaited<ReturnType<typeof run>>;

/** Média de um histograma no intervalo: Δsum / Δcount, em ms. */
function meanMs(before: Metrics, after: Metrics, name: string, filter = ''): number {
  const observations = total(delta(before, after, `${name}_count`, undefined, filter));
  return observations === 0 ? 0 : (total(delta(before, after, `${name}_sum`, undefined, filter)) / observations) * 1000;
}

const ms = (value: number) => value.toFixed(1);

// ---- relatório

const BEGIN = '<!-- load-test:begin -->';
const END = '<!-- load-test:end -->';

const sh = (...cmd: string[]) => {
  try {
    const out = Bun.spawnSync(cmd);
    return out.exitCode === 0 ? out.stdout.toString().trim() : 'indisponível';
  } catch {
    return 'indisponível';
  }
};

async function report(results: Result[]): Promise<void> {
  const [{ version }] = (await sql<{ version: string }>('select version()')) as [{ version: string }];
  const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  const table = (head: string[], rows: (string | number)[][]) =>
    [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
  const block = `${BEGIN}
<!-- Gerado por \`bun run test:load\`. Não edite entre os marcadores: a próxima execução sobrescreve. -->

## Ambiente

- Data: ${new Date().toISOString()} · commit \`${sh('git', 'rev-parse', '--short', 'HEAD')}\`
- CPU: ${os.cpus()[0]?.model ?? '?'} · ${os.cpus().length} CPUs lógicas
- RAM: ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB
- SO: ${os.type()} ${os.release()} (${os.arch()})
- Bun: ${Bun.version}
- Docker: ${sh('docker', 'info', '--format', '{{.ServerVersion}} · {{.NCPU}} CPUs · {{.MemTotal}} bytes de memória')}
- PostgreSQL: ${version.split(' on ')[0]} · LocalStack 4.12 (SQS), ambos pelo Compose
- Gerador de carga, ${INSTANCES} instâncias da aplicação e containers na mesma máquina

## Parâmetros

- Instâncias: ${INSTANCES} processos \`bun src/main.ts\`, configuração padrão exceto ${Object.entries(ENV).map(([k, v]) => `\`${k}=${v}\``).join(', ')}
- Aquecimento descartado: ${WARMUP_S} s por cenário · timeout por requisição: ${TIMEOUT_MS} ms · fração de replays: ${REPLAY_FRACTION}
- Mistura: \`BET 25.00\` 60%, \`WIN 40.00\` 20%, \`LOSS\` 20%

${table(
  ['Cenário', 'Taxa alvo (req/s)', 'Janela medida (s)', 'Wallets'],
  results.map((r) => [r.name, r.rate, r.duration, r.wallets]),
)}

## Resultados

Latência HTTP em ms, medida a partir do instante **agendado** de cada requisição.

${table(
  ['Cenário', 'Enviadas', 'Respostas HTTP/s', 'p50', 'p95', 'p99', 'max', 'Atraso do gerador p99 / max', 'Média no servidor'],
  results.map((r) => [r.name, r.sent, r.throughput.toFixed(1), ms(r.latency.p50), ms(r.latency.p95), ms(r.latency.p99), ms(r.latency.max), `${ms(r.late.p99)} / ${ms(r.late.max)}`, ms(r.serverMeanMs)]),
)}

Respostas por status HTTP (\`422\` = rejeição de negócio; \`503\` = falha transitória; \`timeout\`/\`erro\` = sem resposta):

${table(
  ['Cenário', 'Status'],
  results.map((r) => [r.name, show(r.statuses)]),
)}

Métricas do \`/metrics\` (variação na janela medida + drenagem, somada nas ${INSTANCES} instâncias):

${table(
  ['Cenário', 'Conflitos de lock', 'Retries', 'Duplicatas', 'Outbox: idade máx. da pendente (s)', 'Outbox: publish lag médio (ms)', 'Drenagem após o fim (s)'],
  results.map((r) => [r.name, show(r.lockConflicts), show(r.retries), show(r.duplicates), r.outboxMaxAge.toFixed(2), ms(r.publishLagMeanMs), r.drainSeconds.toFixed(2)]),
)}
${results
  .filter((r) => r.queue)
  .map(
    (r) => `
Cenário \`${r.name}\`, metade pela fila: ${r.queue!.sent} mensagens; latência ponta a ponta (instante agendado do envio → \`completed_at\`), ms: p50 ${ms(r.queue!.latency.p50)} · p95 ${ms(r.queue!.latency.p95)} · p99 ${ms(r.queue!.latency.p99)} · max ${ms(r.queue!.latency.max)}; média de processamento no servidor (canal \`sqs\`): ${ms(r.queue!.serverMeanMs)} ms.`,
  )
  .join('\n')}

## Verificação de correção

Por cenário, nas wallets usadas: reconciliação \`consistent: true\`, saldo = abertura ± transações \`PROCESSED\`, uma transação por idempotency key, um lançamento por transação, nada em estado não terminal.

${results.map((r) => (r.failures.length === 0 ? `- \`${r.name}\`: ✔` : `- \`${r.name}\`: ✘\n${r.failures.map((f) => `  - ${f}`).join('\n')}`)).join('\n')}

${END}`;

  const file = Bun.file('LOAD_TEST.md');
  const current = (await file.exists()) ? await file.text() : `# Teste de carga\n\n${BEGIN}\n${END}\n`;
  const [from, to] = [current.indexOf(BEGIN), current.indexOf(END)];
  if (from < 0 || to < from) throw new Error('LOAD_TEST.md sem os marcadores load-test:begin/end');
  await Bun.write(file, current.slice(0, from) + block + current.slice(to + END.length));
}

// ---- execução

// ponto de partida igual ao da suíte: filas vazias e nenhuma sobra que publisher ou worker fossem pegar
await Promise.all([MAIN, DLQ, EVENTS].map((QueueUrl) => sqs.send(new PurgeQueueCommand({ QueueUrl }))));
await sql('update outbox_messages set published_at = now() where published_at is null');
await sql(`update wager_transactions set next_reference_attempt_at = now() + interval '1 day' where status = 'PENDING_REFERENCE'`);

const instances: Instance[] = [];
const results: Result[] = [];
try {
  for (let i = 0; i < INSTANCES; i++) instances.push(await spawnInstance(ENV));
  console.log(`instâncias: ${instances.map((instance) => instance.base).join(', ')}`);
  for (const scenario of plan) results.push(await run(scenario, instances));
  await report(results);
  console.log('\nrelatório: LOAD_TEST.md');
} finally {
  for (const { proc } of instances) proc.kill('SIGTERM');
  await Promise.all(
    instances.map(async ({ proc }) => {
      await Promise.race([proc.exited, Bun.sleep(25_000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }),
  );
  await orm.close();
}

const failed = results.filter((r) => r.failures.length > 0);
if (failed.length > 0) console.error(`\nverificação de correção falhou em: ${failed.map((r) => r.name).join(', ')}`);
process.exit(failed.length > 0 ? 1 : 0);
