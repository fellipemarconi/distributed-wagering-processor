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

test.each([
  ['OUTBOX_PUBLISHER_ENABLED', 'sim'],
  ['OUTBOX_PUBLISHER_ENABLED', '1'],
  ['OUTBOX_POLL_INTERVAL_MS', '0'],
  ['OUTBOX_POLL_INTERVAL_MS', 'abc'],
  ['OUTBOX_BATCH_SIZE', '0'],
  ['OUTBOX_BATCH_SIZE', '1.5'],
  ['OUTBOX_PUBLISH_TIMEOUT_MS', '-1'],
  ['DB_LOCK_TIMEOUT_MS', 'abc'],
])('%s=%s é recusado com erro que nomeia a variável', (name, value) => {
  expect(() => loadConfig({ [name]: value })).toThrow(name);
});
