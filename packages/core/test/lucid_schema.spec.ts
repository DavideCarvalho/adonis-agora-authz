import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import { AUTHZ_TABLES, createAuthzTables, dropAuthzTables } from '../src/stores/lucid-schema.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

async function tableExists(db: Database, name: string): Promise<boolean> {
  const rows = await db.rawQuery(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return list.length > 0;
}

describe('createAuthzTables / dropAuthzTables (sqlite)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });
  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('creates all five RBAC tables', async () => {
    for (const t of Object.values(AUTHZ_TABLES)) {
      expect(await tableExists(db, t)).toBe(false);
    }

    await createAuthzTables(asLucidDatabase(db));

    for (const t of Object.values(AUTHZ_TABLES)) {
      expect(await tableExists(db, t)).toBe(true);
    }
  });

  it('is idempotent — a second call does not throw', async () => {
    await createAuthzTables(asLucidDatabase(db));
    await createAuthzTables(asLucidDatabase(db));
    expect(await tableExists(db, AUTHZ_TABLES.roles)).toBe(true);
  });

  it('produces tables a store with autoCreateSchema:false can use', async () => {
    // The migration path: create the schema standalone, then run the store against it
    // WITHOUT letting it auto-create. Proves the standalone DDL matches what the store expects.
    await createAuthzTables(asLucidDatabase(db));

    const store = new LucidPermissionStore(asLucidDatabase(db), { autoCreateSchema: false });
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.assignRole({ type: 'user', id: '3' }, 'editor');
    expect(await store.userHasPermission({ type: 'user', id: '3' }, 'posts.edit')).toBe(true);
  });

  it('honors table-name overrides', async () => {
    await createAuthzTables(asLucidDatabase(db), { tables: { roles: 'custom_roles' } });
    expect(await tableExists(db, 'custom_roles')).toBe(true);
    expect(await tableExists(db, AUTHZ_TABLES.roles)).toBe(false);
  });

  it('rejects an unsafe table identifier before touching the db', async () => {
    await expect(
      createAuthzTables(asLucidDatabase(db), { tables: { roles: 'roles; DROP TABLE users' } }),
    ).rejects.toThrow(/unsafe SQL identifier/);
  });

  it('dropAuthzTables removes the tables it created', async () => {
    await createAuthzTables(asLucidDatabase(db));
    expect(await tableExists(db, AUTHZ_TABLES.userRole)).toBe(true);

    await dropAuthzTables(asLucidDatabase(db));

    for (const t of Object.values(AUTHZ_TABLES)) {
      expect(await tableExists(db, t)).toBe(false);
    }
  });

  it('dropAuthzTables is idempotent on a missing schema', async () => {
    await expect(dropAuthzTables(asLucidDatabase(db))).resolves.toBeUndefined();
  });
});

describe('createAuthzTables dialect detection (Postgres → TIMESTAMP)', () => {
  // A fake client that only records SQL, so we can assert the emitted DDL without a real pg.
  function recordingClient(shape: 'root' | 'deferred') {
    const sql: string[] = [];
    const rawQuery = async (q: string) => {
      sql.push(q);
    };
    const client =
      shape === 'deferred'
        ? { rawQuery, dialect: { name: 'postgres' } }
        : { rawQuery, connection: () => ({ dialect: { name: 'postgres' } }) };
    return { client: client as unknown as Parameters<typeof createAuthzTables>[0], sql };
  }

  it('emits TIMESTAMP for a deferred migration query client (dialect direct)', async () => {
    const { client, sql } = recordingClient('deferred');
    await createAuthzTables(client);
    const rolesDdl = sql.find((s) => s.includes(AUTHZ_TABLES.roles) && s.includes('CREATE TABLE'));
    expect(rolesDdl).toContain('TIMESTAMP');
    expect(rolesDdl).not.toContain('DATETIME');
  });

  it('emits TIMESTAMP for the root Database (dialect via connection())', async () => {
    const { client, sql } = recordingClient('root');
    await createAuthzTables(client);
    const rolesDdl = sql.find((s) => s.includes(AUTHZ_TABLES.roles) && s.includes('CREATE TABLE'));
    expect(rolesDdl).toContain('TIMESTAMP');
  });
});
