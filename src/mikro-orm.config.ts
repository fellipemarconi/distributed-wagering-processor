import { Logger } from '@nestjs/common';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig, type Config } from './config';

export function ormOptions(config: Config): Options {
  return defineConfig({
    clientUrl: config.databaseUrl,
    connect: false,
    entities: [],
    discovery: { warnWhenNoEntities: false },
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
