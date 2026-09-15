import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreQueryClient } from '../src/store.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

describe('LucidPermissionStore (sqlite)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });
  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('auto-creates the schema and is idempotent across instances', async () => {
    const a = new LucidPermissionStore(asLucidDatabase(db));
    await a.givePermissionToRole('editor', 'posts.edit');
    await a.assignRole({ type: 'user', id: '7' }, 'editor');

    // A second instance over the same db sees the persisted rows.
    const b = new LucidPermissionStore(asLucidDatabase(db));
    expect(await b.userHasPermission({ type: 'user', id: '7' }, 'posts.edit')).toBe(true);
  });

  it('persists distinct tenant assignments independently', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    const user = { type: 'user', id: '9' };
    await store.givePermissionToRole('billing', 'billing.view');
    await store.assignRole(user, 'billing', { tenantId: 'acme' });

    expect(await store.userHasPermission(user, 'billing.view')).toBe(false);
    expect(await store.userHasPermission(user, 'billing.view', { tenantId: 'acme' })).toBe(true);
    expect(await store.userHasPermission(user, 'billing.view', { tenantId: 'globex' })).toBe(false);
  });

  it('honors autoCreateSchema:false (manual ensureSchema)', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db), { autoCreateSchema: false });
    await store.ensureSchema();
    await store.createRole('manual');
    expect(await store.listRoles()).toContain('manual');
  });

  // Transaction seam (issue #77), three layers with the same precedence:
  // opts.client (per call) → withClient (one injection point) → resolveClient
  // (config, ambient). Reads on the store's OWN connection never overlap an
  // open transaction — on sqlite there is a single pooled connection, so they
  // run before/after, which is exactly the commit/rollback visibility asserted.
  it('writes and reads through the host transaction client (opts.client), committing with it', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();
    const alice = { type: 'user', id: '1' };

    const trx = await db.transaction();
    await store.assignRole(alice, 'editor', undefined, { client: trx });
    await store.givePermissionToRole('editor', 'posts.edit', { client: trx });
    // Inside the transaction: the grant is visible through the same client.
    expect(await store.getRolesForUser(alice, undefined, { client: trx })).toContain('editor');
    expect(await store.userHasPermission(alice, 'posts.edit', undefined, { client: trx })).toBe(
      true,
    );
    await trx.commit();

    // After the commit: visible on the store's own connection too.
    expect(await store.getRolesForUser(alice)).toContain('editor');
    expect(await store.countUsersForRole('editor')).toBe(1);
  });

  it('withClient binds one client for a whole sequence — no per-call options', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();

    const trx = await db.transaction();
    const scoped = store.withClient(trx);
    await scoped.givePermissionToRole('admin', 'system.manage');
    await scoped.assignRole({ type: 'user', id: '1' }, 'admin');
    // The view is a PermissionStore: everything a host does with the store, it
    // does with the view — same tables, same rules, host's transaction.
    expect(await scoped.getRolesForUser({ type: 'user', id: '1' })).toContain('admin');
    expect(await scoped.listRoles()).toContain('admin');
    await trx.commit();

    const trx2 = await db.transaction();
    const scoped2 = store.withClient(trx2);
    await scoped2.deleteRole('admin');
    expect(await scoped2.listRoles()).not.toContain('admin');
    await trx2.rollback();
    expect(await store.listRoles()).toContain('admin');
  });

  it('an explicit opts.client wins over the view (the most local layer)', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();

    // Stub clients, no real transaction: on a single-connection sqlite pool two
    // open transactions would queue forever, and proving the precedence is a
    // pure resolution question anyway.
    const viewClient = { rawQuery: async () => ({ rows: [] }) };
    const seen: string[] = [];
    const callClient = {
      rawQuery: async (sql: string) => {
        seen.push(sql);
        return { rows: [{ name: 'editor' }] };
      },
    };
    const view = store.withClient(viewClient);
    const roles = await view.getRolesForUser({ type: 'user', id: '1' }, undefined, {
      client: callClient,
    });
    expect(roles).toEqual(['editor']);
    expect(seen).toHaveLength(1);
  });

  it('resolveClient (config) joins the ambient transaction automatically', async () => {
    // The host's idiom in production is a tiny AsyncLocalStorage read here;
    // a mutable variable models the same "current client" contract.
    let ambient: StoreQueryClient | undefined;
    const store = new LucidPermissionStore(asLucidDatabase(db), { resolveClient: () => ambient });
    await store.ensureSchema();

    const trx = await db.transaction();
    ambient = trx;
    // No opts anywhere: the configured resolver carries the call into the trx.
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    expect(await store.getRolesForUser({ type: 'user', id: '1' })).toContain('editor');
    await trx.rollback();
    ambient = undefined;

    // Outside the transaction the resolver yields nothing → root connection,
    // and the rolled-back grant is gone.
    expect(await store.getRolesForUser({ type: 'user', id: '1' })).not.toContain('editor');
  });

  it('rolls back with the host transaction — the grant never commits alone', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();

    const trx = await db.transaction();
    await store.createRole('temp', { client: trx });
    expect(await store.listRoles({ client: trx })).toContain('temp');
    await trx.rollback();

    // The role row is gone: with no client, `createRole` would have committed on
    // its own — the failure mode the seam exists to remove.
    expect(await store.listRoles()).not.toContain('temp');
  });

  it('reads inside the transaction see uncommitted writes (the last-admin guard)', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();
    await store.assignRole({ type: 'user', id: '1' }, 'admin');
    await store.assignRole({ type: 'user', id: '2' }, 'admin');

    const trx = await db.transaction();
    const scoped = store.withClient(trx);
    await scoped.removeRole({ type: 'user', id: '1' }, 'admin');
    // The guard's count runs INSIDE the transaction: it sees 1, not the
    // committed 2 — two concurrent requests can no longer both read "2".
    expect(await scoped.countUsersForRole('admin')).toBe(1);
    await trx.commit();
    expect(await store.countUsersForRole('admin')).toBe(1);
  });

  it('deleteRole joins the host transaction when given a client', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');

    const trx = await db.transaction();
    await store.deleteRole('editor', { client: trx });
    expect(await store.listRoles({ client: trx })).not.toContain('editor');
    await trx.rollback();

    // The rollback restored everything: role, grant and membership.
    expect(await store.listRoles()).toContain('editor');
    expect(await store.getRolePermissions('editor')).toContain('posts.edit');
    expect(await store.countUsersForRole('editor')).toBe(1);
  });

  it('the scoped view never touches the root connection (no DDL, no waits)', async () => {
    // A counting wrapper is the root client: the store holds IT, so every
    // root-connection SQL passes through the counter. `connection()` is
    // forwarded so dialect detection still works.
    let rootCalls = 0;
    const counting = {
      rawQuery: (sql: string, bindings?: readonly unknown[]) => {
        rootCalls += 1;
        return db.rawQuery(sql, bindings as never);
      },
      connection: (name?: string) => db.connection(name),
    };
    const store = new LucidPermissionStore(asLucidDatabase(counting as never));
    await store.ensureSchema();
    expect(rootCalls).toBeGreaterThan(0);
    const afterSchema = rootCalls;

    const trx = await db.transaction();
    const scoped = store.withClient(trx);
    await scoped.assignRole({ type: 'user', id: '9' }, 'viewer');
    await scoped.getPermissionsForUser({ type: 'user', id: '9' });
    // Zero root calls while the host transaction is open — no DDL sneak-in, no
    // pool wait, which is what makes the pattern safe on sqlite.
    expect(rootCalls).toBe(afterSchema);
    await trx.commit();
  });
});

describe('LucidPermissionStore with subjectIdType integer (sqlite)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });
  afterEach(async () => {
    await db.manager.closeAll();
  });

  function integerStore() {
    return new LucidPermissionStore(asLucidDatabase(db), { subjectIdType: 'integer' });
  }

  it('round-trips integer ids as native values, refs stay strings', async () => {
    const store = integerStore();
    await store.assignRole({ type: 'user', id: '42' }, 'editor');
    await store.giveUserPermission({ type: 'user', id: '42' }, 'billing.view');
    expect(await store.getRolesForUser({ type: 'user', id: '42' })).toContain('editor');
    expect(await store.getUsersForRole('editor')).toEqual([{ type: 'user', id: '42' }]);
    expect(await store.userHasPermission({ type: 'user', id: '42' }, 'billing.view')).toBe(true);
    expect(await store.countUsersForRole('editor')).toBe(1);
  });

  it('bigint mode guards the same way and names itself in the error', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db), { subjectIdType: 'bigint' });
    await store.assignRole({ type: 'user', id: '4294967342' }, 'editor');
    expect(await store.getRolesForUser({ type: 'user', id: '4294967342' })).toContain('editor');
    await expect(store.assignRole({ type: 'user', id: 'nope' }, 'editor')).rejects.toThrow(
      /subjectIdType 'bigint'/,
    );
  });

  it('refuses non-integer ids LOUDLY instead of silently matching nothing', async () => {
    const store = integerStore();
    await expect(store.assignRole({ type: 'user', id: 'not-an-id' }, 'editor')).rejects.toThrow(
      /subjectIdType 'integer'.*non-integer user id/,
    );
    await expect(store.giveUserPermission({ type: 'user', id: '3f0c1b2a' }, 'x')).rejects.toThrow(
      /subjectIdType 'integer'/,
    );
    await expect(store.getRolesForUser({ type: 'user', id: 'abc' })).rejects.toThrow(
      /subjectIdType 'integer'/,
    );
    // Every user_id binding — the direct-grant read included (Pullfrog caught it unguarded).
    await expect(store.getPermissionsForUser({ type: 'user', id: 'abc' })).rejects.toThrow(
      /subjectIdType 'integer'/,
    );
  });

  it('a text store keeps accepting anything (mixed/uuid hosts unaffected)', async () => {
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '3f0c1b2a-uuid' }, 'editor');
    expect(await store.getRolesForUser({ type: 'user', id: '3f0c1b2a-uuid' })).toContain('editor');
  });
});
