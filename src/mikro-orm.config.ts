import { Logger } from '@nestjs/common';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig, type Config } from './config';
import { schemas } from './infra/persistence/schemas';

export function ormOptions(config: Config): Options {
  return defineConfig({
    clientUrl: config.databaseUrl,
    connect: false,
    // parâmetro de sessão aplicado a toda conexão do pool: wallet travada não segura conexão para sempre
    driverOptions: { connection: { options: `-c lock_timeout=${config.dbLockTimeoutMs}` } },
    entities: schemas,
    extensions: [Migrator],
    migrations: {
      path: 'src/migrations',
      snapshot: false,
      emit: 'ts',
    },
    colors: false,
    logger: (message) => Logger.log(message, 'MikroORM'),
  });
}

export default ormOptions(loadConfig());
