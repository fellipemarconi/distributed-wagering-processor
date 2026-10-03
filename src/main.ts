import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { createLogger } from './logger';

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoot(config), {
  logger: createLogger(config.logLevel),
});
app.enableShutdownHooks();
await app.listen(config.port);
