import { expect, test } from 'bun:test';
import { InvalidPayloadError, parseMoney, parseObject, parseText, parseUuid } from '../../src/application/input';

test('entradas válidas passam inalteradas', () => {
  expect(parseObject({ a: 1 })).toEqual({ a: 1 });
  expect(parseText('provider-a', 'providerId')).toBe('provider-a');
  expect(parseUuid('0192f291-27dd-7d3f-8071-5f8685deef37', 'walletId')).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
  expect(parseMoney({ amount: '25', currency: 'BRL' }, 'money').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
});

test.each([
  ['corpo nulo', () => parseObject(null)],
  ['corpo array', () => parseObject([])],
  ['corpo string', () => parseObject('x')],
  ['texto ausente', () => parseText(undefined, 'f')],
  ['texto vazio', () => parseText('  ', 'f')],
  ['texto não string', () => parseText(1, 'f')],
  ['texto longo demais', () => parseText('x'.repeat(256), 'f')],
  ['uuid malformado', () => parseUuid('w1', 'f')],
  ['money ausente', () => parseMoney(undefined, 'f')],
  ['amount numérico', () => parseMoney({ amount: 10, currency: 'BRL' }, 'f')],
  ['amount negativo', () => parseMoney({ amount: '-1.00', currency: 'BRL' }, 'f')],
  ['amount com 3 casas', () => parseMoney({ amount: '10.005', currency: 'BRL' }, 'f')],
  ['notação científica', () => parseMoney({ amount: '1e3', currency: 'BRL' }, 'f')],
  ['moeda inválida', () => parseMoney({ amount: '1.00', currency: 'real' }, 'f')],
])('%s é InvalidPayloadError', (_name, parse) => {
  expect(parse).toThrow(InvalidPayloadError);
});
