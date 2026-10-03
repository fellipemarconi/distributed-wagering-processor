import { afterEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { loadConfig, type Config } from '../src/config';

// porta 1: conexão recusada de verdade, sem mock
const CLOSED_POSTGRES = 'postgres://wagering:wagering@127.0.0.1:1/wagering_test';
const CLOSED_SQS = 'http://127.0.0.1:1';

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Sobe o AppModule real em uma porta livre e devolve a URL base. */
async function boot(overrides: Partial<Config> = {}): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ ...loadConfig(), ...overrides })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return app.getUrl();
}

test('live responde 200 sem credenciais', async () => {
  const url = await boot();

  const res = await fetch(`${url}/health/live`);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('ready responde 200 com postgres e sqs up', async () => {
  const url = await boot();

  const res = await fetch(`${url}/health/ready`);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
});

test('postgres fora: ready 503 só com o estado das dependências, live continua 200', async () => {
  const url = await boot({ databaseUrl: CLOSED_POSTGRES });

  const ready = await fetch(`${url}/health/ready`);
  expect(ready.status).toBe(503);
  // igualdade exata: nada de mensagem de erro, host, credenciais ou stack no corpo
  expect(await ready.json()).toEqual({ status: 'error', checks: { postgres: 'down', sqs: 'up' } });

  const live = await fetch(`${url}/health/live`);
  expect(live.status).toBe(200);
});

test('sqs fora: ready 503 com sqs down e postgres up, live continua 200', async () => {
  const url = await boot({ awsEndpointUrl: CLOSED_SQS });

  const ready = await fetch(`${url}/health/ready`);
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({ status: 'error', checks: { postgres: 'up', sqs: 'down' } });

  const live = await fetch(`${url}/health/live`);
  expect(live.status).toBe(200);
});

test('dependência que aceita a conexão e não responde vira down dentro do tempo limite', async () => {
  const blackhole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  try {
    const url = await boot({ awsEndpointUrl: `http://127.0.0.1:${blackhole.port}` });

    const startedAt = performance.now();
    const res = await fetch(`${url}/health/ready`);
    const elapsed = performance.now() - startedAt;

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', checks: { postgres: 'up', sqs: 'down' } });
    expect(elapsed).toBeLessThan(3000);
  } finally {
    blackhole.stop(true);
  }
});
