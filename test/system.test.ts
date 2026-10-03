import { expect, test } from 'bun:test';
import { SystemClock, UuidV7IdGenerator } from '../src/infra/system';

test('ids são UUID v7, distintos e ordenados', () => {
  const ids = new UuidV7IdGenerator();
  const [a, b] = [ids.next(), ids.next()];

  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(a).toMatch(V7);
  expect(b).toMatch(V7);
  expect(a).not.toBe(b);
  expect(b >= a).toBe(true);
});

test('relógio devolve o instante atual', () => {
  const before = Date.now();
  const now = new SystemClock().now().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});
