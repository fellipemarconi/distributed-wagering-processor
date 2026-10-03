import { AsyncLocalStorage } from 'node:async_hooks';

/** Ids que acompanham todo log emitido enquanto uma requisição, mensagem ou candidata é tratada. */
export type LogContext = Partial<
  Record<'correlationId' | 'messageId' | 'transactionId' | 'walletId' | 'providerId', string>
>;

const storage = new AsyncLocalStorage<LogContext>();

/** `context` é usado como está (sem cópia): quem abriu enxerga o que `setLogContext` acrescentar. */
export const runWithLogContext = <T>(context: LogContext, fn: () => T): T => storage.run(context, fn);

/** Acrescenta ids ao contexto corrente; fora de um contexto, não faz nada. */
export function setLogContext(fields: LogContext): void {
  const context = storage.getStore();
  if (context) Object.assign(context, fields);
}

export const currentLogContext = (): LogContext => storage.getStore() ?? {};
