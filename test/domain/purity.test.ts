import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN = join(import.meta.dir, '../../src/domain');
const ALLOWED = /^(\.\/|decimal\.js$|node:crypto$)/;

test('src/domain só importa decimal.js, node:crypto e arquivos do próprio domínio', () => {
  const files = readdirSync(DOMAIN, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.flatMap((file) =>
    [...readFileSync(join(DOMAIN, file), 'utf8').matchAll(/\b(?:from|import|require\()\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1]!)
      .filter((spec) => !ALLOWED.test(spec))
      .map((spec) => `${file} -> ${spec}`),
  );
  expect(offenders).toEqual([]);
});
