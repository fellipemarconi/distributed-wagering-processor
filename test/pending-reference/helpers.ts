import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../src/application/ports';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { MikroOrmOutboxRepository } from '../../src/infra/persistence/repositories';
import { payload } from '../application/helpers';
import { sql } from '../persistence/helpers';

export const reprocess = (app: INestApplication) => app.get(ReprocessPendingReferences).execute();

/** Roda lotes até não haver pendente vencida; devolve a soma dos contadores. */
export async function drainPending(app: INestApplication) {
  const total = { processed: 0, rejected: 0, rescheduled: 0, skipped: 0, failed: 0 };
  for (let round = 0; round < 50; round++) {
    const result = await reprocess(app);
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += result[key];
    if (result.selected === 0) return total;
  }
  throw new Error('pendentes não esgotaram em 50 lotes');
}

/**
 * Ponto de partida de cada teste: as pendentes herdadas (de outras suítes e de testes anteriores)
 * são adiadas, para o lote conter só as do teste.
 */
export const quiescePending = (app: INestApplication) =>
  sql(
    app.get(MikroORM),
    `update wager_transactions set next_reference_attempt_at = now() + interval '1 day' where status = 'PENDING_REFERENCE'`,
  );

export interface TxRow {
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  result_balance_amount: string | null;
  created_at: Date;
  completed_at: Date | null;
}

// a consulta crua devolve timestamptz como string
const date = (value: Date | string | null) => (value === null ? null : new Date(value));

export async function txRow(app: INestApplication, id: string): Promise<TxRow> {
  const [row] = await sql<TxRow>(
    app.get(MikroORM),
    `select status, failure_code, reference_transaction_id, reference_attempts, next_reference_attempt_at,
            result_balance_amount, created_at, completed_at
       from wager_transactions where id = ?`,
    [id],
  );
  return {
    ...row!,
    next_reference_attempt_at: date(row!.next_reference_attempt_at),
    created_at: date(row!.created_at)!,
    completed_at: date(row!.completed_at),
  };
}

/** Controla o tempo por SQL (prazo: created_at; backoff: next_reference_attempt_at), sem trocar o Clock. */
export async function patchTx(
  app: INestApplication,
  id: string,
  set: Partial<Pick<TxRow, 'created_at' | 'next_reference_attempt_at' | 'reference_attempts'>>,
): Promise<void> {
  const columns = Object.keys(set);
  await sql(
    app.get(MikroORM),
    `update wager_transactions set ${columns.map((c) => `${c} = ?`).join(', ')} where id = ?`,
    [...Object.values(set), id],
  );
}

export const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);
export const IN_BACKOFF = () => new Date(Date.now() + 3_600_000);

type Target = Parameters<typeof payload>[0];

/** Transação que referencia `referenceExternalTransactionId` (REFUND por padrão). */
export const referencing = (wallet: Target, referenceExternalTransactionId: string, overrides: Record<string, unknown> = {}) =>
  payload(wallet, { kind: 'REFUND', referenceExternalTransactionId, ...overrides });

/** Eventos da transação gerados depois do WagerTransactionPendingReference, com a correlação. */
export const resolutionEvents = (app: INestApplication, transactionId: string) =>
  sql<{ event_type: string; correlation_id: string; failure_code: string | null }>(
    app.get(MikroORM),
    `select event_type, payload->>'correlationId' as correlation_id, payload->'data'->>'failureCode' as failure_code
       from outbox_messages
      where (aggregate_id = ? or payload->'data'->>'transactionId' = ?) and event_type <> 'WagerTransactionPendingReference'
      order by event_type`,
    [transactionId, transactionId],
  );

/** Repositório de outbox real cujo primeiro `add` falha: queda no meio da gravação, antes do commit. */
export const failFirstOutboxAdd = (builder: TestingModuleBuilder): TestingModuleBuilder =>
  builder.overrideProvider(OutboxRepository).useFactory({
    inject: [EntityManager],
    factory: (em: EntityManager): OutboxRepository => {
      const real = new MikroOrmOutboxRepository(em);
      let failed = false;
      return Object.assign(Object.create(real) as OutboxRepository, {
        add: (message: OutboxMessage) => {
          if (failed) return real.add(message);
          failed = true;
          return Promise.reject(new Error('processo caiu antes do commit'));
        },
      });
    },
  });
