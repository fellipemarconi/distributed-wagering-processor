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
  logLevel: LogLevelName;
}

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

  const dbLockTimeoutMs = Number(env.DB_LOCK_TIMEOUT_MS ?? 5000);
  if (!Number.isInteger(dbLockTimeoutMs) || dbLockTimeoutMs < 1) {
    throw new Error(`Configuração inválida: DB_LOCK_TIMEOUT_MS="${env.DB_LOCK_TIMEOUT_MS}" não é um inteiro positivo`);
  }

  return {
    port,
    databaseUrl: url(env, 'DATABASE_URL', 'postgres://wagering:wagering@localhost:5432/wagering'),
    dbLockTimeoutMs,
    awsEndpointUrl: url(env, 'AWS_ENDPOINT_URL', 'http://localhost:4566'),
    awsRegion: env.AWS_REGION || 'us-east-1',
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID || 'test',
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY || 'test',
    sqsQueueName: env.SQS_QUEUE_NAME || 'wager-transactions.fifo',
    logLevel: logLevel as LogLevelName,
  };
}

function url(env: Env, name: string, fallback: string): string {
  const value = env[name] || fallback;
  if (!URL.canParse(value)) {
    throw new Error(`Configuração inválida: ${name} não é uma URL válida`);
  }
  return value;
}
