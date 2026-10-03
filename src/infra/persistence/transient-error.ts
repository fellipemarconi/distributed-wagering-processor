// SQLSTATE: 55P03 lock_timeout, 40P01 deadlock, 40001 serialização, 57P0x servidor caindo/subindo,
// 53300 conexões esgotadas; classe 08 = falha de conexão. E* = erro de socket do Node.
const TRANSIENT_CODES = new Set([
  '55P03',
  '40P01',
  '40001',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

/** Primeiro SQLSTATE (5 caracteres) na cadeia de causas. */
export function sqlStateOf(error: unknown): string | undefined {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * Falha de infraestrutura em que reenviar a mesma operação pode dar certo (HTTP 503; retry na fila).
 * Olha o código do driver e não a classe da exceção: o MikroORM não converte 55P03 nem erro de
 * socket em exceção própria, mas preserva `code` e `cause`.
 */
export function isTransientInfraError(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) return true;
    if (e.name === 'KnexTimeoutError') return true; // pool sem conexão disponível
  }
  return false;
}
