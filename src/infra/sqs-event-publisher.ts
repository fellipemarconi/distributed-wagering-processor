import { Inject, Injectable } from '@nestjs/common';
import { GetQueueUrlCommand, SendMessageCommand, SQSClient, SQSServiceException } from '@aws-sdk/client-sqs';
import { EventPublisher, EventPublisherUnavailableError } from '../application/ports';
import { CONFIG, type Config } from '../config';
import type { OutboxMessage } from '../domain/outbox-message';
import { SQS_CLIENT } from './sqs.provider';

@Injectable()
export class SqsEventPublisher extends EventPublisher {
  private queueUrl?: string;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(CONFIG) private readonly config: Config,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    // um prazo só para a chamada inteira (resolução da fila + envio + retry interno do SDK)
    const abortSignal = AbortSignal.timeout(this.config.outboxPublishTimeoutMs);

    // Fila não resolvida nunca é culpa da mensagem. Só o sucesso fica em cache.
    try {
      this.queueUrl ??= (
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.outboxQueueName }), { abortSignal })
      ).QueueUrl;
    } catch (error) {
      throw new EventPublisherUnavailableError({ cause: error });
    }

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message.payload),
          // ordem por agregado dentro da fila
          MessageGroupId: message.aggregateId,
          // = eventId: reenvio dentro da janela de dedup do FIFO (5 min) não é entregue de novo
          MessageDeduplicationId: message.id,
        }),
        { abortSignal },
      );
    } catch (error) {
      throw isRejection(error) ? error : new EventPublisherUnavailableError({ cause: error });
    }
  }
}

/** O SQS respondeu recusando esta mensagem (4xx que não é throttling). Na dúvida, não é recusa. */
function isRejection(error: unknown): boolean {
  if (!(error instanceof SQSServiceException)) return false;
  const status = error.$metadata.httpStatusCode ?? 0;
  return status >= 400 && status < 500 && !/throttl/i.test(error.name);
}
