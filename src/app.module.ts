import { type DynamicModule, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CONFIG, type Config } from './config';
import { HealthController } from './health/health.controller';
import { sqsProvider } from './infra/sqs.provider';
import { ormOptions } from './mikro-orm.config';

@Module({})
export class AppModule {
  // config entra por parâmetro para os testes subirem o módulo real apontando para outros endpoints
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormOptions(config))],
      controllers: [HealthController],
      providers: [{ provide: CONFIG, useValue: config }, sqsProvider],
    };
  }
}
