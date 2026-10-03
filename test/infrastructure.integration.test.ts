import { expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config';
import { createSqsClient } from '../src/infra/sqs.provider';

const sqs = createSqsClient(loadConfig());

async function attributes(queueName: string) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
  );
  return Attributes ?? {};
}

test('as duas filas existem e são FIFO', async () => {
  const main = await attributes('wager-transactions.fifo');
  const dlq = await attributes('wager-transactions-dlq.fifo');

  expect(main.FifoQueue).toBe('true');
  expect(dlq.FifoQueue).toBe('true');
});

test('a fila de eventos existe e é FIFO', async () => {
  expect((await attributes('wagering-events.fifo')).FifoQueue).toBe('true');
});

test('a fila principal redireciona para a DLQ', async () => {
  const main = await attributes('wager-transactions.fifo');
  const dlq = await attributes('wager-transactions-dlq.fifo');

  const redrive = JSON.parse(main.RedrivePolicy ?? '{}');
  expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn);
  expect(Number(redrive.maxReceiveCount)).toBe(8);
});
