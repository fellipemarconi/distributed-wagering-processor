import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ReprocessPendingReferences } from '../application/reprocess-pending-references';
import { CONFIG, type Config } from '../config';
import { runWithLogContext } from '../observability/log-context';
import { Metrics } from '../observability/metrics';

const LEVEL = { processed: 'log', rejected: 'log', rescheduled: 'debug', skipped: 'debug', failed: 'error' } as const;

// ponytail: segundo loop de polling quase igual ao OutboxPublisherWorker; extrair uma base comum
// se aparecer um terceiro.
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly batch: ReprocessPendingReferences,
    private readonly metrics: Metrics,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.pendingReferenceWorkerEnabled) this.loop = this.run();
  }

  // antes do onApplicationShutdown em que o MikroORM fecha o pool: a candidata em andamento ainda dá commit
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

  /** Devolve se deve esperar o intervalo de polling: só emenda com lote cheio e algum avanço. */
  private async runBatch(): Promise<boolean> {
    try {
      const result = await this.batch.execute(() => this.stopping);
      for (const { kind, durationMs = 0, ...outcome } of result.outcomes) {
        this.metrics.processingDuration.observe({ channel: 'worker' }, durationMs / 1000);
        if (outcome.outcome === 'rescheduled') this.metrics.retries.inc({ source: 'pending_reference' });
        if (kind && (outcome.outcome === 'processed' || outcome.outcome === 'rejected')) {
          this.metrics.transactions.inc({ kind, status: outcome.outcome.toUpperCase(), channel: 'worker' });
        }
        // mesmo correlationId dos eventos que o use case grava para a transação
        const { transactionId, walletId, providerId } = outcome;
        runWithLogContext({ correlationId: transactionId, transactionId, walletId, providerId }, () =>
          this.logger[LEVEL[outcome.outcome]]({ message: 'Pendente de referência reavaliada', kind, ...outcome }),
        );
      }
      const progressed = result.processed + result.rejected + result.rescheduled > 0;
      return !(result.selected === this.config.pendingReferenceBatchSize && progressed);
    } catch (error) {
      // banco fora, por exemplo: nada foi alterado, as pendentes seguem vencidas
      this.logger.error('Lote de pendentes de referência falhou', error instanceof Error ? error.stack : String(error));
      return true;
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.config.pendingReferencePollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
