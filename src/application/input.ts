import { InvalidMoneyError } from '../domain/errors';
import { Money, type MoneyProps } from '../domain/money';

/** Entrada malformada: nada foi gravado e reenviar igual não adianta (HTTP 400; DLQ na fila). */
export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

/** Correlação que acompanha os eventos gerados pela requisição. */
export interface RequestContext {
  correlationId: string;
  causationId?: string;
}

// Validação manual, compartilhada por HTTP e fila: sem dependência nova e sem prender a regra ao transporte.

const MAX_TEXT = 255;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidPayloadError('O corpo deve ser um objeto JSON');
  }
  return input as Record<string, unknown>;
}

export function parseText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    throw new InvalidPayloadError(`${field} deve ser uma string não vazia de até ${MAX_TEXT} caracteres`);
  }
  return value;
}

export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidPayloadError(`${field} deve ser um UUID`);
  return value;
}

export function parseMoney(value: unknown, field: string): Money {
  try {
    return Money.from(value as MoneyProps);
  } catch (error) {
    if (error instanceof InvalidMoneyError) throw new InvalidPayloadError(`${field}: ${error.message}`);
    throw error;
  }
}
