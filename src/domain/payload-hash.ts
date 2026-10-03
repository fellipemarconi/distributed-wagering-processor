import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';

export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = SHA-256 (hex minúsculo) do JSON canônico dos campos de negócio:
 * 1. só os campos de PayloadHashInput entram (allowlist) — idempotencyKey e metadados de transporte ficam fora;
 * 2. money é normalizado para 2 casas ("25" ≡ "25.00");
 * 3. referenceExternalTransactionId ausente é omitido;
 * 4. chaves ordenadas recursivamente, sem espaços.
 */
export function computePayloadHash(input: PayloadHashInput): string {
  const business = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: Money.from(input.money).toJSON(),
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const members = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${members.join(',')}}`;
}
