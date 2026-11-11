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
    expect(await store.subjectHasPermission({ type: 'user', id: '3' }, 'posts.edit')).toBe(true);
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
    expect(await tableExists(db, AUTHZ_TABLES.subjectRole)).toBe(true);

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

describe('role sources: the subject-role pivot', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });
  afterEach(async () => {
    await db.manager.closeAll();
  });

  const alice = { type: 'user', id: '1' };

  /** The pivot exactly as createAuthzTables created it before role sources existed. */
  async function createPreSourcesSchema(): Promise<void> {
    await createAuthzTables(asLucidDatabase(db));
    await db.rawQuery(`DROP TABLE ${AUTHZ_TABLES.subjectRole}`);
    await db.rawQuery(
      `CREATE TABLE ${AUTHZ_TABLES.subjectRole} (
        subject_type VARCHAR(191) NOT NULL,
        subject_id VARCHAR(191) NOT NULL,
        role_id VARCHAR(191) NOT NULL,
        tenant_id VARCHAR(191) NOT NULL DEFAULT '',
        PRIMARY KEY (subject_type, subject_id, role_id, tenant_id)
      )`,
    );
  }

  it('new tables carry source in the primary key', async () => {
    await createAuthzTables(asLucidDatabase(db));
    const columns = (await db.rawQuery(`PRAGMA table_info(${AUTHZ_TABLES.subjectRole})`)) as Array<{
      name: string;
      pk: number;
      dflt_value: string | null;
      notnull: number;
    }>;
    const source = columns.find((c) => c.name === 'source');
    expect(source).toMatchObject({ notnull: 1, dflt_value: "'manual'" });
    expect(source!.pk).toBeGreaterThan(0);
  });

  it('ensureSchema adds the column to a pre-sources table, keeping rows as manual', async () => {
    await createPreSourcesSchema();
    const roleId = 'r-1';
    await db.rawQuery(`INSERT INTO ${AUTHZ_TABLES.roles} (id, name) VALUES (?, ?)`, [
      roleId,
      'editor',
    ]);
    await db.rawQuery(
      `INSERT INTO ${AUTHZ_TABLES.subjectRole} (subject_type, subject_id, role_id, tenant_id) VALUES (?, ?, ?, '')`,
      ['user', '1', roleId],
    );

    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.ensureSchema();
    await store.ensureSchema(); // idempotent
    expect(await store.getRoleAssignments(alice)).toEqual([
      { role: 'editor', source: 'manual', tenantId: null },
    ]);
    // The old key still covers (subject, role, tenant): a second source is ignored until the
    // key is widened — the documented manual step.
    await store.assignRole(alice, 'editor', { source: 'scim' });
    expect(await store.getRoleAssignments(alice)).toHaveLength(1);
  });

  it('the documented SQLite key-widening SQL makes two sources per role work', async () => {
    await createPreSourcesSchema();
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole(alice, 'editor', { tenantId: 't1' });

    // Keep in sync with docs/roles.mdx ("Role sources" → SQLite).
    await db.transaction(async (trx) => {
      await trx.rawQuery(`CREATE TABLE authz_subject_role_new (
        subject_type VARCHAR(191) NOT NULL,
        subject_id VARCHAR(191) NOT NULL,
        role_id VARCHAR(191) NOT NULL,
        tenant_id VARCHAR(191) NOT NULL DEFAULT '',
        source VARCHAR(64) NOT NULL DEFAULT 'manual',
        PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source)
      )`);
      await trx.rawQuery(`INSERT INTO authz_subject_role_new (subject_type, subject_id, role_id, tenant_id, source)
        SELECT subject_type, subject_id, role_id, tenant_id, source FROM authz_subject_role`);
      await trx.rawQuery('DROP TABLE authz_subject_role');
      await trx.rawQuery('ALTER TABLE authz_subject_role_new RENAME TO authz_subject_role');
      await trx.rawQuery(
        'CREATE INDEX IF NOT EXISTS authz_subject_role_subject_idx ON authz_subject_role (subject_type, subject_id)',
      );
    });

    await store.assignRole(alice, 'editor', { tenantId: 't1', source: 'scim' });
    await store.removeRole(alice, 'editor', { tenantId: 't1', source: 'manual' });
    expect(await store.getRoleAssignments(alice, { tenantId: 't1' })).toEqual([
      { role: 'editor', source: 'scim', tenantId: 't1' },
    ]);
  });
});

describe('role sources: dialect DDL', () => {
  function recordingClient(dialect: string) {
    const sql: string[] = [];
    const rawQuery = async (q: string) => {
      sql.push(q);
      return [];
    };
    const client = { rawQuery, dialect: { name: dialect } };
    return { client: client as unknown as Parameters<typeof createAuthzTables>[0], sql };
  }

  it('Postgres adds the column with ADD COLUMN IF NOT EXISTS', async () => {
    const { client, sql } = recordingClient('postgres');
    await createAuthzTables(client);
    expect(sql).toContain(
      `ALTER TABLE ${AUTHZ_TABLES.subjectRole} ADD COLUMN IF NOT EXISTS source VARCHAR(64) NOT NULL DEFAULT 'manual'`,
    );
  });

  it('MySQL keeps the 5-column key under 3072 bytes (ASCII role_id) and checks before adding', async () => {
    const { client, sql } = recordingClient('mysql');
    await createAuthzTables(client);
    const ddl = sql.find((s) =>
      s.includes(`CREATE TABLE IF NOT EXISTS ${AUTHZ_TABLES.subjectRole}`),
    );
    expect(ddl).toContain('role_id VARCHAR(191) CHARACTER SET ascii NOT NULL');
    expect(ddl).toContain('PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source)');
    expect(sql.some((s) => s.includes('information_schema.columns'))).toBe(true);
  });
});
