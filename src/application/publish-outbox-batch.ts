import { Clock, EventPublisher, EventPublisherUnavailableError, OutboxRepository, TransactionRunner } from './ports';

export interface PublishFailure {
  eventId: string;
  eventType: string;
  aggregateId: string;
  /** Tentativas já feitas, contando esta. */
  attempts: number;
  error: string;
  /** Correlação gravada no envelope do evento. */
  correlationId?: string;
}

export interface PublishOutboxBatchResult {
  claimed: number;
  published: number;
  failures: PublishFailure[];
  /** Um por publicação aceita: publishedAt − occurredAt. */
  publishLagsMs: number[];
  /** O destino estava indisponível e o lote parou antes do fim. */
  interrupted: boolean;
}

/**
 * Um lote da outbox: reivindica, publica e registra, tudo em uma transação. Entrega at-least-once:
 * se o commit falhar depois de um envio aceito, a mensagem segue pendente e é reenviada com o
 * mesmo eventId.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  execute(): Promise<PublishOutboxBatchResult> {
    return this.tx.run(async () => {
      const messages = await this.outbox.claimDue(this.clock.now(), this.batchSize);
      const result: PublishOutboxBatchResult = { claimed: messages.length, published: 0, failures: [], publishLagsMs: [], interrupted: false };
      const failedAggregates = new Set<string>();

      for (const message of messages) {
        // Um evento mais novo não passa na frente de um mais antigo do mesmo agregado que falhou.
        // Pulada = intocada: continua vencida, sem contar tentativa.
        if (failedAggregates.has(message.aggregateId)) continue;

        try {
          await this.publisher.publish(message);
          const publishedAt = this.clock.now();
          message.markPublished(publishedAt);
          result.published += 1;
          result.publishLagsMs.push(publishedAt.getTime() - message.occurredAt.getTime());
        } catch (error) {
          message.scheduleRetry(this.clock.now());
          failedAggregates.add(message.aggregateId);
          result.failures.push({
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            error: describe(error),
            correlationId: typeof message.payload.correlationId === 'string' ? message.payload.correlationId : undefined,
          });
          result.interrupted = error instanceof EventPublisherUnavailableError;
        }
        await this.outbox.save(message);

        // Destino fora do ar: insistir só gastaria um timeout e uma tentativa por mensagem.
        // As restantes ficam intocadas; o que já foi publicado é confirmado no commit.
        if (result.interrupted) break;
      }
      return result;
    });
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
