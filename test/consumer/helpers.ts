import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { ProcessWagerMessage, WAGER_CONSUMER_NAME } from '../../src/application/process-wager-message';
import { loadConfig } from '../../src/config';
import { createSqsClient } from '../../src/infra/sqs.provider';
import { waitFor } from '../outbox/helpers';
import { sql, uuid } from '../persistence/helpers';

export { waitFor };

const config = loadConfig();
const sqs = createSqsClient(config);
const urlOf = async (QueueName: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
export const MAIN = await urlOf(config.sqsQueueName);
export const DLQ = await urlOf(config.sqsDlqName);

/** Banco em que nada escuta: conexão recusada na hora (falha transitória real). */
export const DB_DOWN = { databaseUrl: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test' };

/** Envelope da seção 10 do CHALLENGE.md. */
export const envelope = <T>(data: T, overrides: Record<string, unknown> = {}) => ({
  messageId: `msg-${uuid()}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data,
  ...overrides,
});

/**
 * Envia para a fila principal. Sem `dedupId`, cada envio é uma entrega distinta para o SQS — é
 * assim que os testes simulam a reentrega da mesma mensagem (mesmo messageId no envelope).
 */
export async function send(body: unknown, options: { groupId?: string; dedupId?: string } = {}): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: MAIN,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: options.groupId ?? uuid(),
      MessageDeduplicationId: options.dedupId ?? uuid(),
    }),
  );
}

export interface Received {
  body: string;
  reason?: string;
  receiveCount: number;
}

/** Recebe e apaga até a fila esvaziar. */
export async function drain(QueueUrl: string, waitSeconds = 1): Promise<Received[]> {
  const received: Received[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    if (Messages.length === 0) return received;
    received.push(
      ...Messages.map((m) => ({
        body: m.Body!,
        reason: m.MessageAttributes?.reason?.StringValue,
        receiveCount: Number(m.Attributes!.ApproximateReceiveCount),
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

/** Mensagens visíveis + em voo. Zero = tudo foi apagado (ack) ou movido. */
export async function depth(QueueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

export const mainEmpty = async () => (await depth(MAIN)) === 0;

/** Ponto de partida de cada teste: as duas filas vazias. */
export async function quiesce(): Promise<void> {
  await Promise.all([MAIN, DLQ].map((QueueUrl) => sqs.send(new PurgeQueueCommand({ QueueUrl }))));
}

/**
 * Segura o FOR UPDATE da wallet em outra conexão enquanto `during` roda. begin/rollback explícitos,
 * e não `transactional`: este abre um contexto de AsyncLocalStorage que um app iniciado dentro de
 * `during` herdaria, passando a rodar dentro da transação que deveria bloqueá-lo.
 */
export async function holdingLock<T>(app: INestApplication, walletId: string, during: () => Promise<T>): Promise<T> {
  const orm: MikroORM = app.get(MikroORM);
  const holder = orm.em.fork();
  await holder.begin();
  try {
    await holder.execute('select id from wallets where id = ? for update', [walletId]);
    return await during();
  } finally {
    await holder.rollback();
  }
}

export const handle =(app: INestApplication, body: unknown) =>
  app.get(ProcessWagerMessage).execute(typeof body === 'string' ? body : JSON.stringify(body));

export interface InboxRow {
  message_id: string;
  processed_at: string | null;
}

export const inboxOf = (app: INestApplication, messageId: string) =>
  sql<InboxRow>(
    app.get(MikroORM),
    'select message_id, processed_at from inbox_messages where consumer_name = ? and message_id = ?',
    [WAGER_CONSUMER_NAME, messageId],
  );

export const transactionsOf = (app: INestApplication, externalTransactionId: string) =>
  sql<{ id: string; status: string; failure_code: string | null }>(
    app.get(MikroORM),
    'select id, status, failure_code from wager_transactions where external_transaction_id = ?',
    [externalTransactionId],
  );
