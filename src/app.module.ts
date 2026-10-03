import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CreateWallet } from './application/create-wallet';
import {
  Clock,
  IdGenerator,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  WagerTransactionRepository,
  WalletRepository,
} from './application/ports';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { CONFIG, type Config } from './config';
import { HealthController } from './health/health.controller';
import { ApiExceptionFilter } from './http/api-error';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { PersistenceModule } from './infra/persistence/persistence.module';
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
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        ...useCases,
      ],
    };
  }
}
