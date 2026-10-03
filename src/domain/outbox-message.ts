import { backoffDelayMs } from './backoff';
import { DomainError } from './errors';
import type { IntegrationEvent } from './integration-events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: dedupe natural no consumidor em caso de publicação duplicada. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, event.toJSON(), event.occurredAt, 0);
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial com teto. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts));
  }

  private assertPending(): void {
    if (!this.isPending()) throw new DomainError(`Mensagem ${this.id} já foi publicada`);
  }
}
