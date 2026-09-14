import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreQueryClient } from '../src/store.js';
import { type StoreContext, stores } from '../src/stores/factory.js';
import { makeMemoryDatabase } from './lucid_helpers.js';

/**
 * The config seam (issue #77, the Facteur-style wiring): the host wires
 * `stores.lucid({ resolveClient })` ONCE in `config/authz.ts` and plain store
 * calls then auto-join the ambient transaction. These specs prove the factory
 * threads the resolver into the built store — a provider-level guarantee the
 * per-method specs cannot see.
 */
describe('stores.lucid config seam', () => {
  let db: Database;
  const ctx = {
    app: { container: { make: async () => db } },
  } as unknown as StoreContext;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });
  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('resolveClient from config makes plain store calls join the ambient transaction', async () => {
    // The production idiom is an AsyncLocalStorage read; a mutable variable
    // models the same "current client" contract.
    let ambient: StoreQueryClient | undefined;
    const store = await stores.lucid({
      autoCreateSchema: false,
      resolveClient: () => ambient,
    })(ctx);
    await store.ensureSchema();
    await store.createRole('seed');

    const trx = await db.transaction();
    ambient = trx;
    // No opts, no view — the configured resolver carries the write into the trx.
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    expect(await store.getRolesForUser({ type: 'user', id: '1' })).toContain('editor');
    await trx.rollback();
    ambient = undefined;

    // Outside the ambient scope the same calls hit the root connection, and the
    // rolled-back grant is gone.
    expect(await store.getRolesForUser({ type: 'user', id: '1' })).not.toContain('editor');
    expect(await store.listRoles()).toContain('seed');
  });

  it('memory driver ignores the config entirely and stays contract-clean', async () => {
    const store = await stores.memory()(ctx);
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    expect(await store.getRolesForUser({ type: 'user', id: '1' })).toContain('editor');
    expect(store.withClient({ rawQuery: async () => [] })).toBe(store);
  });
});
