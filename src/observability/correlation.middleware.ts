import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { currentLogContext, runWithLogContext, type LogContext } from './log-context';

export const CORRELATION_HEADER = 'X-Correlation-Id';

// Fronteira de confiança: o valor vai para logs, eventos e header de resposta.
const VALID = /^[\w.:-]{1,128}$/;
// probes e scrapes não poluem o log no nível padrão
const QUIET = /^\/(health|metrics)(\/|$)/;

const logger = new Logger('Http');

interface Request {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Response {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): void;
}

/** Header do cliente quando válido; senão um id novo. */
export const correlationIdFrom = (header: unknown): string =>
  typeof header === 'string' && VALID.test(header) ? header : randomUUID();

/** Correlação da requisição em andamento (fora de uma requisição, um id novo). */
export const currentCorrelationId = (): string => currentLogContext().correlationId ?? randomUUID();

/** Abre o contexto de log da requisição, devolve o header e emite o log de acesso. */
export function correlationMiddleware(req: Request, res: Response, next: () => void): void {
  const context: LogContext = { correlationId: correlationIdFrom(req.headers['x-correlation-id']) };
  res.setHeader(CORRELATION_HEADER, context.correlationId!);
  const startedAt = performance.now();
  // o contexto é reaberto explicitamente: o 'finish' não é garantido dentro do AsyncLocalStorage
  res.on('finish', () =>
    runWithLogContext(context, () => {
      const path = req.originalUrl.split('?')[0]!;
      logger[QUIET.test(path) ? 'debug' : 'log']({
        message: 'Requisição atendida',
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }),
  );
  runWithLogContext(context, next);
}
