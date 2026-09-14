import type { ApplicationService } from '@adonisjs/core/types';
import type { PermissionStore, StoreQueryClient } from '../store.js';
import type { AuthzTableNames, LucidDatabase } from './lucid.js';
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
  /** Table-name overrides (defaults match the published migration). */
  tables?: AuthzTableNames;
  /** Auto-create tables on first use (default true). Set false when migrating. */
  autoCreateSchema?: boolean;
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
export const stores = {
  memory(_config: MemoryStoreConfig = {}): StoreProvider {
    return async () => new MemoryPermissionStore();
  },

  lucid(config: LucidStoreConfig = {}): StoreProvider {
    return async (ctx) => {
      // Resolve the db from the container (`lucid.db`) using the passed `app` — NOT via
      // `@adonisjs/lucid/services/db`. That service singleton only assigns its default inside
      // `app.booted(...)` (which runs AFTER every provider's `boot()`), and worse, an `await import()` of
      // it from this library can resolve a module copy whose `app` is undefined
      // (`Cannot read properties of undefined (reading 'booted')`) when the AuthzService is built during
      // boot — which made `make(AuthzService)` throw and take down anything depending on it (e.g. the
      // agent's tool authorizer denied ALL tools fail-closed). The `lucid.db` alias is registered in the
      // database provider's `register()` (before any `boot()`) and is the exact binding `services/db`
      // itself resolves, so it works here and keeps `@adonisjs/lucid` an optional peer.
      const container = ctx.app.container as unknown as { make(binding: string): Promise<unknown> };
      const db = (await container.make('lucid.db')) as { connection(name: string): unknown };
      const { LucidPermissionStore } = await import('./lucid.js');
      const { connection, ...rest } = config;
      const client = (connection ? db.connection(connection) : db) as unknown as LucidDatabase;
      return new LucidPermissionStore(client, rest);
    };
  },
};
