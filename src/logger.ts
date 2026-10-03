import { ConsoleLogger } from '@nestjs/common';
import { LOG_LEVELS, type LogLevelName } from './config';

/** Logger JSON (uma entrada por linha). `level` é o nível mínimo emitido. */
export function createLogger(level: LogLevelName): ConsoleLogger {
  return new ConsoleLogger({
    json: true,
    logLevels: LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(level) + 1),
  });
}
