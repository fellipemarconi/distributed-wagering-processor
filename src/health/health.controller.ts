import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { CONFIG, type Config } from '../config';
import { SQS_CLIENT } from '../infra/sqs.provider';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2000;

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.all([
      this.check('postgres', () => this.orm.em.getDriver().getConnection().execute('select 1')),
      this.check('sqs', () =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqsQueueName })),
      ),
    ]);
    const checks = { postgres, sqs };
    if (postgres === 'down' || sqs === 'down') {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    return { status: 'ok', checks };
  }

  private async check(name: string, probe: () => Promise<unknown>): Promise<CheckStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'up';
    } catch (error) {
      // o erro bruto fica só no log; o corpo da resposta nunca o expõe
      this.logger.warn(`readiness: ${name} indisponível (${error instanceof Error ? error.name : 'erro'})`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
