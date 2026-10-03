import { setTimeout as sleep } from 'node:timers/promises';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { identifyMessage, ProcessWagerMessage, type DeadLetterReason } from '../application/process-wager-message';
import { CONFIG, visibilityMarginMs, type Config } from '../config';
import { backoffDelayMs } from '../domain/backoff';
import { runWithLogContext, setLogContext } from '../observability/log-context';
import { Metrics } from '../observability/metrics';
import { isTransientInfraError } from './persistence/transient-error';
import { SQS_CLIENT } from './sqs.provider';

const RECEIVE_ERROR_PAUSE_MS = 1000;

/** Consumidor da fila de transações. Classificação e garantias: ARCHITECTURE.md. */
@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  /** Abortado no shutdown: marca a parada e interrompe a pausa entre erros de receive. */
  private readonly stop = new AbortController();
  private loop?: Promise<void>;
  private queueUrl?: string;
  private dlqUrl?: string;

  constructor(
    private readonly processMessage: ProcessWagerMessage,
    private readonly metrics: Metrics,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.sqsConsumerEnabled) this.loop = this.run();
  }

  // Antes do onApplicationShutdown em que o MikroORM fecha o pool: as mensagens em andamento
  // ainda têm conexão para dar commit.
  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.loop;
  }

  private get stopping(): boolean {
    return this.stop.signal.aborted;
  }

  // ponytail: o lote é a unidade de paralelismo — uma mensagem lenta segura o próximo receive
  // desta instância. Trocar por pool deslizante se o throughput pedir.
  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const messages = await this.receive();
        const receivedAt = Date.now();
        // Grupos em paralelo; dentro do grupo, em série e na ordem de entrega do FIFO.
        const groups = new Map<string | undefined, Message[]>();
        for (const message of messages) {
          const groupId = message.Attributes?.MessageGroupId;
          groups.set(groupId, [...(groups.get(groupId) ?? []), message]);
        }
        await Promise.all([...groups.values()].map((group) => this.processGroup(group, receivedAt)));
      } catch (error) {
        if (this.stopping) return;
        this.logger.error('Falha ao receber da fila', error instanceof Error ? error.stack : String(error));
        await sleep(RECEIVE_ERROR_PAUSE_MS, undefined, { signal: this.stop.signal }).catch(() => {});
      }
    }
  }

  private async receive(): Promise<Message[]> {
    // só o sucesso fica em cache
    this.queueUrl ??= await this.urlOf(this.config.sqsQueueName);
    this.dlqUrl ??= await this.urlOf(this.config.sqsDlqName);
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.config.sqsConsumerBatchSize,
        WaitTimeSeconds: this.config.sqsConsumerWaitTimeSeconds,
        VisibilityTimeout: this.config.sqsConsumerVisibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      // O cliente compartilhado tem requestTimeout curto, menor que o long polling. Sem abortSignal
      // de propósito: um receive abandonado ainda pode ganhar mensagens no SQS, que ficariam
      // invisíveis até a visibilidade vencer. O shutdown espera a resposta e devolve o que vier.
      { requestTimeout: (this.config.sqsConsumerWaitTimeSeconds + 5) * 1000 },
    );
    return Messages;
  }

  private async urlOf(QueueName: string): Promise<string> {
    return (await this.sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
  }

  private async processGroup(messages: Message[], receivedAt: number): Promise<void> {
    for (const [index, message] of messages.entries()) {
      const hold = this.stopping ? 'shutdown' : this.visibilityLeftMs(receivedAt) < visibilityMarginMs(this.config) ? 'visibility' : undefined;
      if (hold) return this.release(messages.slice(index), hold, 0);
      // As seguintes do grupo voltam com o mesmo adiamento da que falhou (ajustada antes): ficam
      // visíveis depois dela e o FIFO as entrega na ordem, sem depender de o broker bloquear o grupo.
      const retryInSeconds = await this.handle(message);
      if (retryInSeconds !== undefined) return this.release(messages.slice(index + 1), 'blocked', retryInSeconds);
    }
  }

  private visibilityLeftMs(receivedAt: number): number {
    return this.config.sqsConsumerVisibilityTimeoutSeconds * 1000 - (Date.now() - receivedAt);
  }

  /** Devolve o adiamento (em segundos) quando a mensagem ficou para nova tentativa. */
  private handle(message: Message): Promise<number | undefined> {
    const body = message.Body ?? '';
    // contexto de log da mensagem: os avisos de ack e de visibilidade também saem com os ids
    return runWithLogContext(this.ids(body), async () => {
      const stopTimer = this.metrics.processingDuration.startTimer({ channel: 'sqs' });
      try {
        return await this.process(message, body);
      } finally {
        stopTimer();
      }
    });
  }

  private async process(message: Message, body: string): Promise<number | undefined> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    try {
      const result = await this.processMessage.execute(body);
      // execute retornou: o commit já aconteceu (ou nada foi gravado)
      if (result.outcome === 'dead') {
        await this.sendToDlq(message, result.reason);
        this.metrics.dlqMessages.inc({ reason: result.reason });
        await this.ack(message);
        this.logger.warn({ message: 'Mensagem enviada para a DLQ', outcome: 'dead', reason: result.reason, ...this.ids(body), receiveCount });
        return undefined;
      }
      await this.ack(message);
      const tx = 'transaction' in result ? result.transaction : undefined;
      if (tx) {
        setLogContext({ transactionId: tx.id });
        this.metrics.recordWager('sqs', result.outcome, tx);
      } else {
        this.metrics.duplicates.inc({ type: 'inbox_duplicate', channel: 'sqs' });
      }
      this.logger.log({
        message: 'Mensagem consumida',
        outcome: result.outcome,
        correlationId: result.messageId,
        messageId: result.messageId,
        ...(tx ? { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId } : {}),
        receiveCount,
      });
      return undefined;
    } catch (error) {
      // Erro inesperado também é reenviado: na dúvida, não descartar. O redrive da fila limita.
      const transient = isTransientInfraError(error);
      const delaySeconds = Math.min(backoffDelayMs(receiveCount) / 1000, this.config.sqsConsumerMaxBackoffSeconds);
      await this.changeVisibility(message, delaySeconds);
      this.metrics.retries.inc({ source: 'sqs_consumer' });
      const entry = { message: 'Mensagem será reenviada', outcome: 'retry', transient, ...this.ids(body), receiveCount, delaySeconds };
      if (transient) this.logger.warn({ ...entry, error: (error as Error).name });
      else this.logger.error(entry, error instanceof Error ? error.stack : String(error));
      return delaySeconds;
    }
  }

  private ids(body: string) {
    const { messageId, walletId, providerId } = identifyMessage(body);
    return { correlationId: messageId, messageId, walletId, providerId };
  }

  private async sendToDlq(message: Message, reason: DeadLetterReason): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body,
        MessageGroupId: message.Attributes?.MessageGroupId,
        // reenvio depois de um ack que falhou não duplica na DLQ (janela de dedup do FIFO)
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
  }

  /** Falha aqui não é erro de processamento: a mensagem reaparece e a inbox a reconhece. */
  private async ack(message: Message): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      this.logger.warn({ message: 'Falha ao apagar mensagem já tratada; será reentregue', sqsMessageId: message.MessageId, error: (error as Error).name });
    }
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
      );
    } catch (error) {
      // sem o ajuste, a mensagem volta ao fim do tempo de visibilidade original
      this.logger.warn({ message: 'Falha ao ajustar visibilidade', sqsMessageId: message.MessageId, error: (error as Error).name });
    }
  }

  /** Caminho único de devolução das mensagens recebidas e não iniciadas (0 = visíveis de imediato). */
  private async release(messages: Message[], why: 'shutdown' | 'visibility' | 'blocked', seconds: number): Promise<void> {
    if (messages.length === 0) return;
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: messages.map((message, i) => ({ Id: String(i), ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds })),
        }),
      );
    } catch (error) {
      this.logger.warn({ message: 'Falha ao devolver mensagens', why, error: (error as Error).name });
    }
    for (const message of messages) {
      this.logger.log({ message: 'Mensagem devolvida sem iniciar', outcome: 'released', why, ...this.ids(message.Body ?? '') });
    }
  }
}
