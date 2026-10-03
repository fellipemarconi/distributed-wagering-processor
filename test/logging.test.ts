import { afterEach, expect, spyOn, test } from 'bun:test';
import { createLogger } from '../src/logger';
import { runWithLogContext, setLogContext } from '../src/observability/log-context';

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

test('objeto logado sai achatado no primeiro nível, com message como texto', () => {
  const out = capture('stdout');

  createLogger('log').log({ message: 'consumida', outcome: 'processed', receiveCount: 2 }, 'Ctx');

  const entry = JSON.parse(out[0]!);
  expect(entry).toMatchObject({ level: 'log', message: 'consumida', outcome: 'processed', receiveCount: 2, context: 'Ctx' });
});

test('log dentro de um contexto traz os ids; campo explícito vence o contexto; level não é sobrescrito', () => {
  const out = capture('stdout');
  const logger = createLogger('log');

  runWithLogContext({ correlationId: 'c-1', walletId: 'w-1' }, () => {
    setLogContext({ transactionId: 't-1' });
    logger.log('texto simples');
    logger.log({ message: 'objeto', walletId: 'w-explicito', level: 'forjado' });
  });
  logger.log('fora do contexto');

  const [plain, object, outside] = out.map((line) => JSON.parse(line));
  expect(plain).toMatchObject({ message: 'texto simples', correlationId: 'c-1', walletId: 'w-1', transactionId: 't-1' });
  expect(object).toMatchObject({ message: 'objeto', correlationId: 'c-1', walletId: 'w-explicito', level: 'log' });
  expect(outside.correlationId).toBeUndefined();
});

test('setLogContext fora de contexto não lança; contextos concorrentes não se misturam', async () => {
  const out = capture('stdout');
  const logger = createLogger('log');
  expect(() => setLogContext({ walletId: 'w' })).not.toThrow();

  await Promise.all(
    ['a', 'b', 'c'].map((id) =>
      runWithLogContext({ correlationId: id }, async () => {
        await Bun.sleep(Math.random() * 10);
        setLogContext({ transactionId: `tx-${id}` });
        await Bun.sleep(Math.random() * 10);
        logger.log(id);
      }),
    ),
  );

  for (const entry of out.map((line) => JSON.parse(line))) {
    expect(entry).toMatchObject({ correlationId: entry.message, transactionId: `tx-${entry.message}` });
  }
  expect(out).toHaveLength(3);
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
