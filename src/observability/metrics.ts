import { Controller, Get, Header, Inject, Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { OutboxRepository } from '../application/ports';
import { CONFIG, type Config } from '../config';
import { SQS_CLIENT } from '../infra/sqs.provider';

export type Channel = 'http' | 'sqs' | 'worker';

const DLQ_DEPTH_TIMEOUT_MS = 1000;

/**
 * Métricas da instância (ARCHITECTURE.md). Labels só de conjuntos fechados do código: nunca ids
 * (wallet, transação, jogador, provedor, mensagem) nem valores monetários.
 */
@Injectable()
export class Metrics {
  // Registry próprio, não o global do prom-client: os testes sobem vários AppModule no mesmo processo.
  readonly registry = new Registry();
  private readonly registers = [this.registry];
  private dlqUrl?: string;

  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações que chegaram a um desfecho gravado (replays não contam)',
    labelNames: ['kind', 'status', 'channel'],
    registers: this.registers,
  });
  readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicatas reconhecidas: replay idempotente ou mensagem já registrada na inbox',
    labelNames: ['type', 'channel'],
    registers: this.registers,
  });
  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas agendadas: outbox, consumidor SQS e PENDING_REFERENCE',
    labelNames: ['source'],
    registers: this.registers,
  });
  readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ pelo consumidor desta instância (não inclui o redrive do SQS)',
    labelNames: ['reason'],
    registers: this.registers,
  });
  readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Transações de banco abortadas por lock timeout, deadlock ou corrida decidida por unicidade',
    labelNames: ['type'],
    registers: this.registers,
  });
  readonly outboxPublishLag = new Histogram({
    name: 'wagering_outbox_publish_lag_seconds',
    help: 'Intervalo entre a ocorrência do evento e a sua publicação',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 900],
    registers: this.registers,
  });
  readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Tempo de processamento de uma submissão, mensagem ou pendente reavaliada',
    labelNames: ['channel'],
    registers: this.registers,
  });
  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliações que terminaram com consistent: false',
    registers: this.registers,
  });

  constructor(
    outbox: OutboxRepository,
    @Inject(SQS_CLIENT) sqs: SQSClient,
    @Inject(CONFIG) config: Config,
  ) {
    // Os dois gauges são estado externo (banco, broker), não da instância: lidos a cada scrape.
    // Falha vira NaN — /metrics não cai junto com a dependência.
    const metrics = this;
    new Gauge({
      name: 'wagering_outbox_oldest_pending_age_seconds',
      help: 'Idade do evento não publicado mais antigo (0 sem pendentes)',
      registers: this.registers,
      async collect() {
        this.set(
          await outbox.oldestPendingOccurredAt().then(
            (oldest) => (oldest ? Math.max(0, (Date.now() - oldest.getTime()) / 1000) : 0),
            () => NaN,
          ),
        );
      },
    });
    new Gauge({
      name: 'wagering_dlq_depth',
      help: 'Mensagens na DLQ de transações segundo o SQS (inclui as movidas pelo redrive)',
      registers: this.registers,
      async collect() {
        this.set(await metrics.dlqDepth(sqs, config).catch(() => NaN));
      },
    });
  }

  /** Desfecho de uma submissão (HTTP ou fila) que resultou em transação gravada. */
  recordWager(channel: Channel, outcome: string, tx: { kind: string; status: string }): void {
    if (outcome === 'replay') this.duplicates.inc({ type: 'idempotent_replay', channel });
    else this.transactions.inc({ kind: tx.kind, status: tx.status, channel });
  }

  private async dlqDepth(sqs: SQSClient, config: Config): Promise<number> {
    // um prazo só para resolver a fila e ler o atributo; só o sucesso fica em cache
    const abortSignal = AbortSignal.timeout(DLQ_DEPTH_TIMEOUT_MS);
    this.dlqUrl ??= (await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqsDlqName }), { abortSignal })).QueueUrl;
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
      { abortSignal },
    );
    return Number(Attributes?.ApproximateNumberOfMessages);
  }
}

/** Aberto como o health: sem AuthGuard. */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
