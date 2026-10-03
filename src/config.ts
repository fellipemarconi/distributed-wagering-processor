export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  databaseUrl: string;
  /** Espera máxima por lock de linha (wallet travada). Estourou → falha transitória (503). */
  dbLockTimeoutMs: number;
  awsEndpointUrl: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  sqsQueueName: string;
  /** Liga o worker que publica a outbox nesta instância. Desligado, a instância só grava eventos. */
  outboxPublisherEnabled: boolean;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  /** Limite de cada envio ao SQS, incluindo o retry interno do SDK. */
  outboxPublishTimeoutMs: number;
  outboxQueueName: string;
  /** Liga o consumidor da fila de transações nesta instância. Desligado, a instância só atende HTTP. */
  sqsConsumerEnabled: boolean;
  sqsDlqName: string;
  /** Mensagens por receive (1–10): é também o limite de processamento paralelo da instância. */
  sqsConsumerBatchSize: number;
  sqsConsumerWaitTimeSeconds: number;
  sqsConsumerVisibilityTimeoutSeconds: number;
  /** Teto do adiamento de uma mensagem que falhou de forma transitória. */
  sqsConsumerMaxBackoffSeconds: number;
  logLevel: LogLevelName;
}

/** Folga, além da espera máxima por lock, para commit e ack antes de a visibilidade vencer. */
const VISIBILITY_SLACK_MS = 5000;

/** Tempo mínimo de visibilidade restante para o consumidor iniciar uma mensagem. */
export const visibilityMarginMs = (config: Pick<Config, 'dbLockTimeoutMs'>): number =>
  config.dbLockTimeoutMs + VISIBILITY_SLACK_MS;

export const CONFIG = Symbol('CONFIG');

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Configuração inválida: PORT="${env.PORT}" não é uma porta válida (0-65535)`);
  }

  const logLevel = env.LOG_LEVEL ?? 'log';
  if (!LOG_LEVELS.includes(logLevel as LogLevelName)) {
    throw new Error(`Configuração inválida: LOG_LEVEL="${logLevel}" (use ${LOG_LEVELS.join(' | ')})`);
  }

  const dbLockTimeoutMs = positiveInt(env, 'DB_LOCK_TIMEOUT_MS', 5000);
  const sqsConsumerVisibilityTimeoutSeconds = positiveInt(env, 'SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS', 30);
  const marginMs = visibilityMarginMs({ dbLockTimeoutMs });
  if (sqsConsumerVisibilityTimeoutSeconds * 1000 <= marginMs) {
    // abaixo da margem o consumidor nunca iniciaria mensagem alguma
    throw new Error(
      `Configuração inválida: SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS=${sqsConsumerVisibilityTimeoutSeconds} deve ser maior que DB_LOCK_TIMEOUT_MS + 5s (${marginMs}ms)`,
    );
  }

  return {
    port,
    databaseUrl: url(env, 'DATABASE_URL', 'postgres://wagering:wagering@localhost:5432/wagering'),
    dbLockTimeoutMs,
    sqsConsumerEnabled: bool(env, 'SQS_CONSUMER_ENABLED'),
    sqsDlqName: env.SQS_DLQ_NAME || 'wager-transactions-dlq.fifo',
    sqsConsumerBatchSize: positiveInt(env, 'SQS_CONSUMER_BATCH_SIZE', 10, 10),
    sqsConsumerWaitTimeSeconds: positiveInt(env, 'SQS_CONSUMER_WAIT_TIME_SECONDS', 20, 20),
    sqsConsumerVisibilityTimeoutSeconds,
    sqsConsumerMaxBackoffSeconds: positiveInt(env, 'SQS_CONSUMER_MAX_BACKOFF_SECONDS', 300),
    outboxPublisherEnabled: bool(env, 'OUTBOX_PUBLISHER_ENABLED'),
    outboxPollIntervalMs: positiveInt(env, 'OUTBOX_POLL_INTERVAL_MS', 1000),
    outboxBatchSize: positiveInt(env, 'OUTBOX_BATCH_SIZE', 10),
    outboxPublishTimeoutMs: positiveInt(env, 'OUTBOX_PUBLISH_TIMEOUT_MS', 2000),
    outboxQueueName: env.OUTBOX_QUEUE_NAME || 'wagering-events.fifo',
    awsEndpointUrl: url(env, 'AWS_ENDPOINT_URL', 'http://localhost:4566'),
    awsRegion: env.AWS_REGION || 'us-east-1',
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID || 'test',
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY || 'test',
    sqsQueueName: env.SQS_QUEUE_NAME || 'wager-transactions.fifo',
    logLevel: logLevel as LogLevelName,
  };
}

function positiveInt(env: Env, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Configuração inválida: ${name}="${env[name]}" não é um inteiro positivo válido`);
  }
  return value;
}

/** Ausente ou vazio = ligado. */
function bool(env: Env, name: string): boolean {
  const value = env[name] || 'true';
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Configuração inválida: ${name}="${value}" (use true | false)`);
  }
  return value === 'true';
}

function url(env: Env, name: string, fallback: string): string {
  const value = env[name] || fallback;
  if (!URL.canParse(value)) {
    throw new Error(`Configuração inválida: ${name} não é uma URL válida`);
  }
  return value;
}
