import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CreateWallet } from './application/create-wallet';
import {
  Clock,
  EventPublisher,
  IdGenerator,
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  WagerTransactionRepository,
  WalletRepository,
} from './application/ports';
import { ProcessWagerMessage } from './application/process-wager-message';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { PublishOutboxBatch } from './application/publish-outbox-batch';
import { CONFIG, type Config } from './config';
import { HealthController } from './health/health.controller';
import { ApiExceptionFilter } from './http/api-error';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { PersistenceModule } from './infra/persistence/persistence.module';
import { OutboxPublisherWorker } from './infra/outbox-publisher.worker';
import { SqsEventPublisher } from './infra/sqs-event-publisher';
import { SqsWagerConsumer } from './infra/sqs-wager-consumer';
import { sqsProvider } from './infra/sqs.provider';
import { ormOptions } from './mikro-orm.config';

// Use cases são classes puras (src/application não conhece o NestJS): entram por factory.
const USE_CASE_DEPS = [
  TransactionRunner,
  WalletRepository,
  WagerTransactionRepository,
  LedgerRepository,
  OutboxRepository,
  IdGenerator,
  Clock,
];
const useCases: Provider[] = [
  {
    provide: CreateWallet,
    inject: USE_CASE_DEPS,
    useFactory: (...deps: ConstructorParameters<typeof CreateWallet>) => new CreateWallet(...deps),
  },
  {
    provide: ProcessWagerTransaction,
    inject: USE_CASE_DEPS,
    useFactory: (...deps: ConstructorParameters<typeof ProcessWagerTransaction>) => new ProcessWagerTransaction(...deps),
  },
  {
    provide: ProcessWagerMessage,
    inject: [TransactionRunner, InboxRepository, ProcessWagerTransaction, Clock],
    useFactory: (...deps: ConstructorParameters<typeof ProcessWagerMessage>) => new ProcessWagerMessage(...deps),
  },
  {
    provide: PublishOutboxBatch,
    inject: [TransactionRunner, OutboxRepository, EventPublisher, Clock, CONFIG],
    useFactory: (tx: TransactionRunner, outbox: OutboxRepository, publisher: EventPublisher, clock: Clock, config: Config) =>
      new PublishOutboxBatch(tx, outbox, publisher, clock, config.outboxBatchSize),
  },
];

@Module({})
export class AppModule {
  // config entra por parâmetro para os testes subirem o módulo real apontando para outros endpoints
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormOptions(config)), PersistenceModule],
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        { provide: CONFIG, useValue: config },
        sqsProvider,
        // classe concreta também registrada: os testes embrulham o adapter real em vez de mocká-lo
        SqsEventPublisher,
        { provide: EventPublisher, useExisting: SqsEventPublisher },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        ...useCases,
        OutboxPublisherWorker,
        SqsWagerConsumer,
      ],
    };
  }
}
