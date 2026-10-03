import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { InvalidMoneyError } from '../../src/domain/errors';
import { computePayloadHash, type PayloadHashInput } from '../../src/domain/payload-hash';
import { brl, tx } from './fixtures';

const payload: PayloadHashInput = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('computePayloadHash', () => {
  test('é o SHA-256 em hex minúsculo do JSON canônico documentado', () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"p1","providerId":"provider-a",' +
      '"roundId":"round-987","walletId":"w1"}';
    const hash = computePayloadHash(payload);
    expect(hash).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('ordem das chaves é irrelevante', () => {
    const reversed = Object.fromEntries(Object.entries(payload).reverse()) as unknown as PayloadHashInput;
    reversed.money = { currency: 'BRL', amount: '25.00' };
    expect(computePayloadHash(reversed)).toBe(computePayloadHash(payload));
  });

  test('escala do valor é irrelevante', () => {
    const unscaled = { ...payload, money: { amount: '25', currency: 'BRL' } };
    expect(computePayloadHash(unscaled)).toBe(computePayloadHash(payload));
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: 'w2' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' }],
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '25.00', currency: 'USD' } }],
    ['referência', { referenceExternalTransactionId: 'transaction-100' }],
  ])('mudar %s altera o hash', (_name, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });

  test('campos fora do subconjunto de negócio são ignorados', () => {
    const noisy = { ...payload, idempotencyKey: 'outra-key', messageId: 'msg-1', occurredAt: 'agora', extra: 1 };
    expect(computePayloadHash(noisy)).toBe(computePayloadHash(payload));
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(payload),
    );
  });

  test('valor inválido é rejeitado, não normalizado', () => {
    expect(() => computePayloadHash({ ...payload, money: { amount: '25.001', currency: 'BRL' } })).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('idempotency key com payload divergente', () => {
  const existing = tx({ money: brl('25.00') }); // já persistida sob a key provider-a:ext-BET

  const incomingHash = (amount: string) =>
    computePayloadHash({
      providerId: existing.providerId,
      externalTransactionId: existing.externalTransactionId,
      playerId: existing.playerId,
      walletId: existing.walletId,
      roundId: existing.roundId,
      gameId: existing.gameId,
      kind: existing.kind,
      money: { amount, currency: 'BRL' },
    });

  test('mesma key, payload idêntico: replay', () => {
    expect(existing.matchesPayload(incomingHash('25.00'))).toBe(true);
    expect(existing.matchesPayload(incomingHash('25'))).toBe(true);
  });

  test('mesma key, valor diferente: conflito, não replay', () => {
    expect(existing.matchesPayload(incomingHash('26.00'))).toBe(false);
  });
});
