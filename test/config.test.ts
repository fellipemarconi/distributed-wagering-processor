import { expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

test('publisher da outbox: padrões', () => {
  expect(loadConfig({})).toMatchObject({
    outboxPublisherEnabled: true,
    outboxPollIntervalMs: 1000,
    outboxBatchSize: 10,
    outboxPublishTimeoutMs: 2000,
    outboxQueueName: 'wagering-events.fifo',
  });
});

test('publisher da outbox: valores informados', () => {
  const config = loadConfig({
    OUTBOX_PUBLISHER_ENABLED: 'false',
    OUTBOX_POLL_INTERVAL_MS: '250',
    OUTBOX_BATCH_SIZE: '50',
    OUTBOX_PUBLISH_TIMEOUT_MS: '500',
    OUTBOX_QUEUE_NAME: 'outra.fifo',
  });

  expect(config).toMatchObject({
    outboxPublisherEnabled: false,
    outboxPollIntervalMs: 250,
    outboxBatchSize: 50,
    outboxPublishTimeoutMs: 500,
    outboxQueueName: 'outra.fifo',
  });
});

test('consumidor SQS: padrões', () => {
  expect(loadConfig({})).toMatchObject({
    sqsConsumerEnabled: true,
    sqsQueueName: 'wager-transactions.fifo',
    sqsDlqName: 'wager-transactions-dlq.fifo',
    sqsConsumerBatchSize: 10,
    sqsConsumerWaitTimeSeconds: 20,
    sqsConsumerVisibilityTimeoutSeconds: 30,
    sqsConsumerMaxBackoffSeconds: 300,
  });
});

test('consumidor SQS: valores informados', () => {
  const config = loadConfig({
    SQS_CONSUMER_ENABLED: 'false',
    SQS_DLQ_NAME: 'outra-dlq.fifo',
    SQS_CONSUMER_BATCH_SIZE: '1',
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '7',
    SQS_CONSUMER_MAX_BACKOFF_SECONDS: '1',
    DB_LOCK_TIMEOUT_MS: '1000', // margem de 6s: 7s de visibilidade passa
  });

  expect(config).toMatchObject({
    sqsConsumerEnabled: false,
    sqsDlqName: 'outra-dlq.fifo',
    sqsConsumerBatchSize: 1,
    sqsConsumerWaitTimeSeconds: 1,
    sqsConsumerVisibilityTimeoutSeconds: 7,
    sqsConsumerMaxBackoffSeconds: 1,
  });
});

test('worker de PENDING_REFERENCE: padrões e valores informados', () => {
  expect(loadConfig({})).toMatchObject({
    pendingReferenceWorkerEnabled: true,
    pendingReferencePollIntervalMs: 1000,
    pendingReferenceBatchSize: 20,
    pendingReferenceTtlSeconds: 900,
  });
  const config = loadConfig({
    PENDING_REFERENCE_WORKER_ENABLED: 'false',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '250',
    PENDING_REFERENCE_BATCH_SIZE: '5',
    PENDING_REFERENCE_TTL_SECONDS: '60',
  });
  expect(config).toMatchObject({
    pendingReferenceWorkerEnabled: false,
    pendingReferencePollIntervalMs: 250,
    pendingReferenceBatchSize: 5,
    pendingReferenceTtlSeconds: 60,
  });
});

test('visibilidade menor que a margem nomeia a variável mesmo quando o culpado é o lock timeout', () => {
  expect(() => loadConfig({ DB_LOCK_TIMEOUT_MS: '30000' })).toThrow('SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS');
});

test.each([
  ['OUTBOX_PUBLISHER_ENABLED', 'sim'],
  ['OUTBOX_PUBLISHER_ENABLED', '1'],
  ['OUTBOX_POLL_INTERVAL_MS', '0'],
  ['OUTBOX_POLL_INTERVAL_MS', 'abc'],
  ['OUTBOX_BATCH_SIZE', '0'],
  ['OUTBOX_BATCH_SIZE', '1.5'],
  ['OUTBOX_PUBLISH_TIMEOUT_MS', '-1'],
  ['DB_LOCK_TIMEOUT_MS', 'abc'],
  ['SQS_CONSUMER_ENABLED', 'sim'],
  ['SQS_CONSUMER_BATCH_SIZE', '0'],
  ['SQS_CONSUMER_BATCH_SIZE', '11'],
  ['SQS_CONSUMER_WAIT_TIME_SECONDS', '0'],
  ['SQS_CONSUMER_WAIT_TIME_SECONDS', '21'],
  ['SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS', 'abc'],
  ['SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS', '10'], // = margem (lock de 5s + 5s): nada seria iniciado
  ['SQS_CONSUMER_MAX_BACKOFF_SECONDS', '0'],
  ['PENDING_REFERENCE_WORKER_ENABLED', 'sim'],
  ['PENDING_REFERENCE_POLL_INTERVAL_MS', '0'],
  ['PENDING_REFERENCE_BATCH_SIZE', '1.5'],
  ['PENDING_REFERENCE_TTL_SECONDS', '0'],
  ['PENDING_REFERENCE_TTL_SECONDS', 'abc'],
])('%s=%s é recusado com erro que nomeia a variável', (name, value) => {
  expect(() => loadConfig({ [name]: value })).toThrow(name);
});
