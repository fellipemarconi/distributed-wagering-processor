import { afterEach, expect, spyOn, test } from 'bun:test';
import { createLogger } from '../src/logger';

function capture(stream: 'stdout' | 'stderr') {
  const lines: string[] = [];
  const spy = spyOn(process[stream], 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  restores.push(() => spy.mockRestore());
  return lines;
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

test('entrada de log é uma linha JSON com timestamp, nível e mensagem', () => {
  const out = capture('stdout');

  createLogger('log').log('hello', 'Ctx');

  expect(out).toHaveLength(1);
  expect(out[0]!.trimEnd()).not.toContain('\n');
  const entry = JSON.parse(out[0]!);
  expect(entry).toMatchObject({ level: 'log', message: 'hello', context: 'Ctx' });
  expect(entry.timestamp).toBeDefined();
});

test('erro sai como uma única linha JSON em stderr com o stack em um campo', () => {
  const out = capture('stdout');
  const err = capture('stderr');
  const stack = new Error('boom').stack!;

  createLogger('log').error('boom', stack, 'Ctx');

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(1);
  expect(err[0]!.trimEnd()).not.toContain('\n');
  const entry = JSON.parse(err[0]!);
  expect(entry).toMatchObject({ level: 'error', message: 'boom', stack });
});

test('nível mínimo warn suprime mensagens informativas', () => {
  const out = capture('stdout');
  const logger = createLogger('warn');

  logger.log('suprimida');
  expect(out).toHaveLength(0);

  logger.warn('emitida');
  expect(out).toHaveLength(1);
});

test('todas as linhas do bootstrap são JSON', async () => {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'log' },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  let output = '';
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    output += decoder.decode(chunk);
    if (output.includes('successfully started')) break;
  }
  proc.kill();
  await proc.exited;

  const lines = output.split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
});
