import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutboxBatch } from '../application/publish-outbox-batch';
import { CONFIG, type Config } from '../config';
import { Metrics } from '../observability/metrics';

/** Nenhum evento é abandonado; acima disso, cada nova falha vira warning (sinal operacional). */
const WARN_AFTER_ATTEMPTS = 5;

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly batch: PublishOutboxBatch,
    private readonly metrics: Metrics,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.outboxPublisherEnabled) this.loop = this.run();
  }

  // beforeApplicationShutdown roda antes do onApplicationShutdown em que o MikroORM fecha o pool:
  // o lote em andamento ainda tem conexão para dar commit.
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const idle = await this.runBatch();
      if (idle && !this.stopping) await this.sleep();
    }
  }

  /** Devolve se deve esperar o intervalo de polling: lote cheio e sem interrupção emenda o próximo. */
  private async runBatch(): Promise<boolean> {
    try {
      const result = await this.batch.execute();
      for (const lagMs of result.publishLagsMs) this.metrics.outboxPublishLag.observe(lagMs / 1000);
      this.metrics.retries.inc({ source: 'outbox' }, result.failures.length);
      for (const failure of result.failures) {
        // sem o payload: nada de dado financeiro em log
        const level = failure.attempts > WARN_AFTER_ATTEMPTS ? 'warn' : 'debug';
        this.logger[level]({ message: 'Falha ao publicar evento da outbox', ...failure });
      }
      return result.interrupted || result.claimed < this.config.outboxBatchSize;
    } catch (error) {
      // banco fora, por exemplo: nada foi confirmado, as mensagens seguem pendentes
      this.logger.error('Lote da outbox falhou', error instanceof Error ? error.stack : String(error));
      return true;
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.config.outboxPollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
