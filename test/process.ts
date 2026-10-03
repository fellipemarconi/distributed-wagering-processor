import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Instance {
  proc: ReturnType<typeof Bun.spawn>;
  base: string;
  /** Linhas de log (JSON) emitidas até agora. */
  logs(): Record<string, unknown>[];
}

/** Processo real da aplicação (`src/main.ts`) em uma porta livre, já respondendo em /health/live. */
export async function spawnInstance(env: Record<string, string>): Promise<Instance> {
  const port = await freePort();
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'log', ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  let output = '';
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) output += decoder.decode(chunk, { stream: true });
  })();

  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 15_000;
  while (!(await fetch(`${base}/health/live`).then((r) => r.ok, () => false))) {
    if (Date.now() > deadline || proc.exitCode !== null) {
      proc.kill('SIGKILL');
      throw new Error('instância não subiu a tempo');
    }
    await Bun.sleep(25);
  }
  return {
    proc,
    base,
    logs: () =>
      output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
