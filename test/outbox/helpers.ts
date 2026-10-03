import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { EventPublisher, OutboxRepository } from '../../src/application/ports';
import { PublishOutboxBatch } from '../../src/application/publish-outbox-batch';
import { loadConfig } from '../../src/config';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { MikroOrmOutboxRepository } from '../../src/infra/persistence/repositories';
import { SqsEventPublisher } from '../../src/infra/sqs-event-publisher';
import { createSqsClient } from '../../src/infra/sqs.provider';
import { sql, uuid } from '../persistence/helpers';

const config = loadConfig();
const sqs = createSqsClient(config);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.outboxQueueName }));

/** Endpoint em que nada escuta: conexão recusada na hora. */
export const SQS_DOWN = { awsEndpointUrl: 'http://127.0.0.1:1' };

export interface Received {
  body: Record<string, unknown>;
  groupId: string;
  deduplicationId: string;
}

/** Recebe e apaga até a fila esvaziar (em FIFO, mensagem em voo bloqueia o grupo dela). */
export async function drain(): Promise<Received[]> {
  const received: Received[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (Messages.length === 0) return received;
    received.push(
      ...Messages.map((m) => ({
        body: JSON.parse(m.Body!),
        groupId: m.Attributes!.MessageGroupId!,
        deduplicationId: m.Attributes!.MessageDeduplicationId!,
      })),
    );
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl,
        Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }
}

/**
 * Ponto de partida de cada teste: fila vazia e nenhuma pendência herdada — um publisher ligado
 * publicaria as sobras das outras suítes.
 */
export async function quiesce(app: INestApplication): Promise<void> {
  await sql(app.get(MikroORM), 'update outbox_messages set published_at = now() where published_at is null');
  await sqs.send(new PurgeQueueCommand({ QueueUrl }));
}

/** Grava uma mensagem pendente direto na outbox, com agregado, ordem e tentativas à escolha. */
export async function enqueue(
  app: INestApplication,
  overrides: { aggregateId?: string; occurredAt?: Date; attempts?: number; nextAttemptAt?: Date } = {},
): Promise<OutboxMessage> {
  const id = uuid();
  const aggregateId = overrides.aggregateId ?? uuid();
  const occurredAt = overrides.occurredAt ?? new Date();
  const message = OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'TestEvent',
    payload: { eventId: id, eventType: 'TestEvent', aggregateId, occurredAt: occurredAt.toISOString(), version: 1, data: { secret: 'payload-nao-vai-para-o-log' } },
    occurredAt,
    attempts: overrides.attempts ?? 0,
    nextAttemptAt: overrides.nextAttemptAt,
  });
  await app.get(OutboxRepository).add(message);
  return message;
}

export const runBatch = (app: INestApplication) => app.get(PublishOutboxBatch).execute();

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

/** Linhas na ordem dos ids informados. */
export async function rows(app: INestApplication, ids: string[]): Promise<OutboxRow[]> {
  const found = await sql<OutboxRow>(
    app.get(MikroORM),
    `select id, aggregate_id, payload, attempts, next_attempt_at, published_at
       from outbox_messages where id in (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return ids.map((id) => withDates(found.find((row) => row.id === id)!));
}

export const pendingRows = async (app: INestApplication) =>
  (
    await sql<OutboxRow>(
      app.get(MikroORM),
      'select id, aggregate_id, payload, attempts, next_attempt_at, published_at from outbox_messages where published_at is null order by occurred_at, id',
    )
  ).map(withDates);

// a consulta crua devolve timestamptz como string
const date = (value: Date | string | null) => (value === null ? null : new Date(value));
const withDates = (row: OutboxRow): OutboxRow => ({
  ...row,
  next_attempt_at: date(row.next_attempt_at),
  published_at: date(row.published_at),
});

type Customize = (builder: TestingModuleBuilder) => TestingModuleBuilder;

/**
 * Embrulha o adapter SQS real: `before` roda antes de cada envio (registrar, atrasar ou lançar)
 * e, se não lançar, o envio real acontece.
 */
export const wrapPublisher =
  (before: (message: OutboxMessage) => void | Promise<void>): Customize =>
  (builder) =>
    builder.overrideProvider(EventPublisher).useFactory({
      inject: [SqsEventPublisher],
      factory: (real: SqsEventPublisher): EventPublisher => ({
        publish: async (message) => {
          await before(message);
          await real.publish(message);
        },
      }),
    });

/** Repositório real cujo primeiro `save` falha: simula a queda entre o envio aceito e o commit. */
export const failFirstSave: Customize = (builder) =>
  builder.overrideProvider(OutboxRepository).useFactory({
    inject: [EntityManager],
    factory: (em: EntityManager): OutboxRepository => {
      const real = new MikroOrmOutboxRepository(em);
      let failed = false;
      return Object.assign(Object.create(real) as OutboxRepository, {
        save: (message: OutboxMessage) => {
          if (failed) return real.save(message);
          failed = true;
          return Promise.reject(new Error('processo caiu antes de marcar'));
        },
      });
    },
  });

export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condição não satisfeita a tempo');
    await Bun.sleep(25);
  }
}
