import type { ApplicationService } from '@adonisjs/core/types';
import type { PermissionStore, StoreQueryClient } from '../store.js';
import {
  type AuthzSubjectIdType,
  type AuthzTableNames,
  assertSchemaName,
  assertSchemaSupported,
  detectDialect,
  type LucidDatabase,
} from './lucid-schema.js';
import { MemoryPermissionStore } from './memory.js';

export interface StoreContext {
  app: ApplicationService;
}

/**
 * A configured store: a thunk the provider calls at boot. Each provider lazily
 * imports its optional peer dependency INSIDE the thunk, so the driver (and its
 * peer) is only loaded when actually selected.
 */
export type StoreProvider = (ctx: StoreContext) => Promise<PermissionStore>;

export interface MemoryStoreConfig {
  // Reserved for future options; the memory store currently takes none.
}

export interface LucidStoreConfig {
  /** Lucid connection name; defaults to the app's default connection. */
  connection?: string;
  /**
   * Keep the tables in this Postgres schema (MySQL: database) instead of the connection's
   * default. Every statement names it (`"authz".authz_roles`), so it works on any connection —
   * the app's own transaction included — and never depends on `search_path` (safe behind
   * PgBouncer in transaction mode). Created on first use when `autoCreateSchema` is on.
   * Postgres/MySQL only: on SQLite the app fails to boot.
   */
  schema?: string;
  /** Table-name overrides (defaults match the published migration). */
  tables?: AuthzTableNames;
  /** Auto-create tables on first use (default true). Set false when migrating. */
  autoCreateSchema?: boolean;
  /**
   * The `subject_id` pivot column type: `'text'` (default, every subject kind),
   * `'integer'` or `'bigint'` (the host's native key type — must match the
   * tables, see `createAuthzTables` and the migration stub). Subject *types*
   * stay polymorphic either way; this is only about the id column type.
   */
  subjectIdType?: AuthzSubjectIdType;
  /**
   * Ambient transaction seam (wired once, like a channel config): read before
   * each data method; a non-nullish return runs that call's SQL on it — the
   * host's idiom is a tiny AsyncLocalStorage around `db.transaction`.
   * Precedence per call: `opts.client` → `store.withClient(…)` → this
   * resolver → the store's own connection. Ignored by the memory store.
   */
  resolveClient?: () => StoreQueryClient | undefined;
}

/**
 * The `stores` namespace lives in core (drivers-in-core idiom). Each factory
 * returns a lazy async thunk; calling it in config is free. The Lucid driver
 * `await import()`s `@adonisjs/lucid/services/db` and its own adapter module only
 * when the provider builds it — keeping the peer optional.
 */
/** Where a Lucid store thunk keeps its DB settings, so boot can check them without building it. */
const LUCID_STORE_TARGET = Symbol.for('@adonis-agora/authz/lucid-store-target');

interface LucidStoreTarget {
  connection: string | undefined;
  schema: string | undefined;
}

/** Resolve the Lucid `db` from the container (see the note in {@link stores.lucid}). */
async function lucidDb(ctx: StoreContext): Promise<{ connection(name?: string): unknown }> {
  const container = ctx.app.container as unknown as { make(binding: string): Promise<unknown> };
  return (await container.make('lucid.db')) as { connection(name?: string): unknown };
}

/** The `schema` a `stores.lucid()` thunk was configured with (`undefined` for any other store). */
export function storeSchemaOf(provider: StoreProvider | undefined): string | undefined {
  if (!provider) return undefined;
  return (provider as unknown as Record<symbol, LucidStoreTarget | undefined>)[LUCID_STORE_TARGET]
    ?.schema;
}

/**
 * Boot-time check of a store's `schema` against its connection's dialect, without building the
 * store (no query runs). Throws on a dialect without schemas (SQLite). A no-op for stores without
 * `schema` and for non-Lucid stores.
 */
export async function assertStoreSchema(provider: StoreProvider, ctx: StoreContext): Promise<void> {
  const target = (provider as unknown as Record<symbol, LucidStoreTarget | undefined>)[
    LUCID_STORE_TARGET
  ];
  if (target?.schema === undefined) return;
  const db = await lucidDb(ctx);
  const client = db.connection(target.connection) as LucidDatabase;
  assertSchemaSupported(target.schema, detectDialect(client));
}

export const stores = {
  memory(_config: MemoryStoreConfig = {}): StoreProvider {
    return async () => new MemoryPermissionStore();
  },

  lucid(config: LucidStoreConfig = {}): StoreProvider {
    // A malformed schema name fails as soon as config/authz.ts loads.
    if (config.schema !== undefined) assertSchemaName(config.schema);
    const provider: StoreProvider = async (ctx) => {
      // Resolve the db from the container (`lucid.db`) using the passed `app` — NOT via
      // `@adonisjs/lucid/services/db`. That service singleton only assigns its default inside
      // `app.booted(...)` (which runs AFTER every provider's `boot()`), and worse, an `await import()` of
      // it from this library can resolve a module copy whose `app` is undefined
      // (`Cannot read properties of undefined (reading 'booted')`) when the AuthzService is built during
      // boot — which made `make(AuthzService)` throw and take down anything depending on it (e.g. the
      // agent's tool authorizer denied ALL tools fail-closed). The `lucid.db` alias is registered in the
      // database provider's `register()` (before any `boot()`) and is the exact binding `services/db`
      // itself resolves, so it works here and keeps `@adonisjs/lucid` an optional peer.
      const db = await lucidDb(ctx);
      const { LucidPermissionStore } = await import('./lucid.js');
      const { connection, ...rest } = config;
      const client = (connection ? db.connection(connection) : db) as unknown as LucidDatabase;
      return new LucidPermissionStore(client, rest);
    };
    const target: LucidStoreTarget = { connection: config.connection, schema: config.schema };
    Object.defineProperty(provider, LUCID_STORE_TARGET, { value: target });
    return provider;
  },
};
