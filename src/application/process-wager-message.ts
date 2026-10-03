import { createHash } from 'node:crypto';
import { InboxMessage } from '../domain/inbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import { InvalidPayloadError, parseObject, parseText } from './input';
import { Clock, InboxRepository, TransactionRunner, UniqueViolationError } from './ports';
import { ProcessWagerTransaction } from './process-wager-transaction';

export const WAGER_CONSUMER_NAME = 'wager-transactions';
const MESSAGE_TYPE = 'WagerTransactionRequested';
const INBOX_PK = 'pk_inbox_messages';

/** Motivo pelo qual a mensagem nunca poderá ser processada (atributo `reason` na DLQ). */
export type DeadLetterReason =
  | 'INVALID_ENVELOPE'
  | 'INVALID_PAYLOAD'
  | 'WALLET_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT';

/** Sem noção de SQS: o adapter traduz em ack, DLQ ou retry. Falha de infraestrutura sai como exceção. */
export type ProcessWagerMessageResult =
  | { outcome: 'processed' | 'rejected' | 'pending' | 'replay'; messageId: string; transaction: WagerTransaction }
  | { outcome: 'duplicate'; messageId: string }
  | { outcome: 'dead'; reason: DeadLetterReason; messageId?: string };

interface Envelope {
  messageId: string;
  data: Record<string, unknown>;
}

export class ProcessWagerMessage {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly inbox: InboxRepository,
    private readonly processWager: ProcessWagerTransaction,
    private readonly clock: Clock,
  ) {}

  /** `body`: corpo bruto da mensagem (envelope da seção 10 do CHALLENGE.md). Fluxo: ARCHITECTURE.md. */
  async execute(body: string): Promise<ProcessWagerMessageResult> {
    const envelope = parseEnvelope(body);
    if (!envelope) return { outcome: 'dead', reason: 'INVALID_ENVELOPE' };
    const { messageId, data } = envelope;

    try {
      // Transação externa: o runner.run do use case vira savepoint dentro dela, então inbox,
      // transação financeira, ledger, wallet e outbox têm um único commit.
      return await this.runner.run<ProcessWagerMessageResult>(async () => {
        const seen = await this.inbox.find(WAGER_CONSUMER_NAME, messageId);
        if (seen) return { outcome: 'duplicate', messageId };

        const result = await this.processWager.execute(data, { correlationId: messageId, causationId: messageId });
        // Sem registro na inbox para o que vai à DLQ: se o envio falhar, a reentrega não pode
        // ser confundida com duplicata.
        if (result.outcome === 'not-found') return { outcome: 'dead', reason: 'WALLET_NOT_FOUND', messageId };
        if (result.outcome === 'conflict') return { outcome: 'dead', reason: result.code, messageId };

        const at = this.clock.now();
        const received = InboxMessage.receive({
          messageId,
          consumerName: WAGER_CONSUMER_NAME,
          payloadHash: createHash('sha256').update(body).digest('hex'),
          receivedAt: at,
        });
        received.markProcessed(at); // um INSERT só, já processada
        await this.inbox.add(received);
        return { ...result, messageId };
      });
    } catch (error) {
      if (error instanceof InvalidPayloadError) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', messageId };
      // Outra instância gravou a inbox desta mensagem primeiro: tudo que esta fez foi desfeito.
      if (error instanceof UniqueViolationError && error.constraint === INBOX_PK) {
        return { outcome: 'duplicate', messageId };
      }
      throw error;
    }
  }
}

function parseEnvelope(body: string): Envelope | undefined {
  try {
    const envelope = parseObject(JSON.parse(body));
    if (envelope.type !== MESSAGE_TYPE) return undefined;
    // validado e não usado: o instante da transação é o do relógio do servidor, como na HTTP
    if (typeof envelope.occurredAt !== 'string' || Number.isNaN(Date.parse(envelope.occurredAt))) return undefined;
    return { messageId: parseText(envelope.messageId, 'messageId'), data: parseObject(envelope.data) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidPayloadError) return undefined;
    throw error;
  }
}

/** Identificação para log quando não há transação (DLQ, falha): melhor esforço, só ids, nunca valores. */
export function identifyMessage(body: string): { messageId?: string; walletId?: string; providerId?: string } {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  try {
    const envelope = JSON.parse(body) as { messageId?: unknown; data?: { walletId?: unknown; providerId?: unknown } };
    return {
      messageId: text(envelope?.messageId),
      walletId: text(envelope?.data?.walletId),
      providerId: text(envelope?.data?.providerId),
    };
  } catch {
    return {};
  }
}
