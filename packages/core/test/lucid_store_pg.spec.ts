import { randomUUID } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LucidDatabase } from '../src/stores/lucid.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';

/**
 * Real-Postgres coverage for the reverse lookup `getUsersForRole`. Points at the
 * developer's local Postgres (the `adonis-filter-pg` container by default):
 *   host localhost, port 55432, user/pass postgres, db filter_test.
 * Override via PG_* env vars. Each run uses a UNIQUE table prefix so it is
 * isolated and needs no teardown of shared fixtures — the store auto-creates its
 * own tables and we drop them in afterAll.
 */
const PG = {
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 55432),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'postgres',
  database: process.env.PG_DATABASE ?? 'filter_test',
};

function makePgDatabase(): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const logger = new LoggerFactory().create();
  const emitter = new Emitter(app);
  return new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'pg',
          connection: {
            host: PG.host,
            port: PG.port,
            user: PG.user,
            password: PG.password,
            database: PG.database,
          },
        },
      },
    },
    logger,
    emitter,
  );
}

const asLucid = (db: Database) => db as unknown as LucidDatabase;

/**
 * Probe the backend once (short timeout). When it is reachable the suite runs for
 * REAL against Postgres; when it is not (e.g. CI without the container), the suite
 * SKIPS instead of failing — the repo's default suite is otherwise sqlite-only and
 * must not hard-depend on an external Postgres. Start one with the `adonis-filter-pg`
 * container or any local Postgres and this suite lights up.
 */
async function probePostgres(): Promise<boolean> {
  const client = new Client({ ...PG, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const PG_AVAILABLE = await probePostgres();

describe.skipIf(!PG_AVAILABLE)('LucidPermissionStore.getUsersForRole (real Postgres)', () => {
  let db: Database;
  const prefix = `authz_pgtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const tables = {
    roles: `${prefix}_roles`,
    permissions: `${prefix}_permissions`,
    rolePermission: `${prefix}_role_permission`,
    userRole: `${prefix}_user_role`,
    userPermission: `${prefix}_user_permission`,
  };
  const store = () => new LucidPermissionStore(asLucid(db), { tables });

  beforeAll(async () => {
    db = makePgDatabase();
    // Reachability was already established by the top-level probe (this describe is
    // skipped otherwise). Kept as a fast sanity check on the Lucid connection.
    await db.rawQuery('SELECT 1');
  });

  afterAll(async () => {
    if (db) {
      for (const t of [
        tables.userPermission,
        tables.userRole,
        tables.rolePermission,
        tables.permissions,
        tables.roles,
      ]) {
        await db.rawQuery(`DROP TABLE IF EXISTS ${t} CASCADE`).catch(() => {});
      }
      await db.manager.closeAll();
    }
  });

  it('returns every ref holding the role and excludes others', async () => {
    const s = store();
    await s.assignRole({ type: 'user', id: '100' }, 'editor');
    await s.assignRole({ type: 'user', id: '101' }, 'editor');
    await s.assignRole({ type: 'admin', id: '100' }, 'editor'); // same id, different type
    await s.assignRole({ type: 'user', id: '999' }, 'viewer'); // different role

    const editors = await s.getUsersForRole('editor');
    expect(editors).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '100' },
        { type: 'user', id: '101' },
        { type: 'admin', id: '100' },
      ]),
    );
    expect(editors).toHaveLength(3);
    expect(editors).not.toContainEqual({ type: 'user', id: '999' });
    expect(await s.getUsersForRole('nobody')).toEqual([]);
  });

  it('isolates tenants: a t1 assignee never appears when querying t2', async () => {
    const s = store();
    await s.assignRole({ type: 'user', id: '200' }, 'billing'); // global
    await s.assignRole({ type: 'user', id: '201' }, 'billing', { tenantId: 'A' });
    await s.assignRole({ type: 'user', id: '202' }, 'billing', { tenantId: 'B' });

    // Global request: only the global assignee.
    expect(await s.getUsersForRole('billing')).toEqual([{ type: 'user', id: '200' }]);

    // Tenant A: global + A's own, NOT B's.
    const a = await s.getUsersForRole('billing', { tenantId: 'A' });
    expect(a).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '200' },
        { type: 'user', id: '201' },
      ]),
    );
    expect(a).toHaveLength(2);
    expect(a).not.toContainEqual({ type: 'user', id: '202' });

    // Tenant B: global + B's own, NOT A's.
    const b = await s.getUsersForRole('billing', { tenantId: 'B' });
    expect(b).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '200' },
        { type: 'user', id: '202' },
      ]),
    );
    expect(b).toHaveLength(2);
    expect(b).not.toContainEqual({ type: 'user', id: '201' });
  });
});
