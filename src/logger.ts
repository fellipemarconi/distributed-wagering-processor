import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { LOG_LEVELS, type LogLevelName } from './config';
import { currentLogContext } from './observability/log-context';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Toda linha JSON passa por getJsonLogObject. O Nest aninharia um objeto logado em `message`;
 * aqui os campos dele e os ids do contexto (AsyncLocalStorage) vão para o primeiro nível, e
 * `message` é sempre texto. Campo explícito vence o contexto; level/pid/timestamp vencem todos.
 */
class JsonLogger extends ConsoleLogger {
  protected override getJsonLogObject(
    message: unknown,
    options: { context: string; logLevel: LogLevel; writeStreamType?: 'stdout' | 'stderr'; errorStack?: unknown },
  ) {
    const { message: text, ...fields } = isPlainObject(message) ? message : { message };
    return {
      ...currentLogContext(),
      ...fields,
      ...super.getJsonLogObject(typeof text === 'string' ? text : String(text ?? ''), options),
    };
  }
}

/** Logger JSON (uma entrada por linha). `level` é o nível mínimo emitido. */
export function createLogger(level: LogLevelName): ConsoleLogger {
  return new JsonLogger({
    json: true,
    logLevels: LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(level) + 1),
  });
}
