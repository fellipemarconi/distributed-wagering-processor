import { Module, type Provider } from '@nestjs/common';
import {
  Clock,
  IdGenerator,
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { SystemClock, UuidV7IdGenerator } from '../system';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmTransactionRunner,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories';

const providers: Provider[] = [
  { provide: WalletRepository, useClass: MikroOrmWalletRepository },
  { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
  { provide: LedgerRepository, useClass: MikroOrmLedgerRepository },
  { provide: InboxRepository, useClass: MikroOrmInboxRepository },
  { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
  { provide: TransactionRunner, useClass: MikroOrmTransactionRunner },
  { provide: IdGenerator, useClass: UuidV7IdGenerator },
  { provide: Clock, useClass: SystemClock },
];

// O EntityManager vem do MikroOrmModule.forRoot (global) registrado no AppModule.
@Module({ providers, exports: providers.map((p) => (p as { provide: Provider }).provide) })
export class PersistenceModule {}
