// Preload do `bun test`: roda antes de qualquer arquivo de teste.
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config';
import { createSqsClient } from '../src/infra/sqs.provider';
import { ormOptions } from '../src/mikro-orm.config';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';

// Publisher desligado por padrão: só os testes da outbox o ligam (por override de Config),
// para as demais suítes não publicarem na fila de eventos.
process.env.OUTBOX_PUBLISHER_ENABLED ??= 'false';
// Idem para o consumidor: só os testes de test/consumer o ligam.
process.env.SQS_CONSUMER_ENABLED ??= 'false';
// Idem para o worker de PENDING_REFERENCE: o banco é compartilhado e ele mexeria nas pendentes das outras suítes.
process.env.PENDING_REFERENCE_WORKER_ENABLED ??= 'false';

const HINT ='Suba as dependências com `docker compose up -d --wait` (ou use `bun run test:integration`).';

// SKIP_INFRA=1 (script test:unit): testes de domínio puro não precisam de Postgres/SQS.
if (process.env.SKIP_INFRA !== '1') {
  const config = loadConfig();
  const orm = await MikroORM.init({ ...ormOptions(config), logger: () => {} });
  try {
    try {
      await orm.em.getDriver().getConnection().execute('select 1');
    } catch {
      throw new Error(`PostgreSQL de teste inacessível. ${HINT}`);
    }
    for (const QueueName of [config.sqsQueueName, config.sqsDlqName, config.outboxQueueName]) {
      try {
        await createSqsClient(config).send(new GetQueueUrlCommand({ QueueName }));
      } catch {
        throw new Error(`SQS inacessível ou fila ${QueueName} inexistente. ${HINT}`);
      }
    }
    await orm.getMigrator().up();
  } finally {
    await orm.close();
  }
}
