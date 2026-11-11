import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import type { LucidDatabase } from '../src/stores/lucid-schema.js';

/** A fresh standalone Lucid `Database` over an isolated `:memory:` sqlite db. */
export function makeMemoryDatabase(): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const logger = new LoggerFactory().create();
  const emitter = new Emitter(app);

  return new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
        },
      },
    },
    logger,
    emitter,
  );
}

export function asLucidDatabase(db: Database): LucidDatabase {
  return db as unknown as LucidDatabase;
}
