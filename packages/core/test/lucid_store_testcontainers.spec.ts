import { execFileSync } from 'node:child_process';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { Adapter, BaseModel, column, manyToMany } from '@adonisjs/lucid/orm';
import type { ManyToMany } from '@adonisjs/lucid/types/relations';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authzRolesRelation } from '../src/lucid_relation.js';
import type { StoreQueryClient } from '../src/store.js';
import type { LucidDatabase } from '../src/stores/lucid.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import type { AuthzTableNames } from '../src/stores/lucid-schema.js';
import { createAuthzTables } from '../src/stores/lucid-schema.js';
import { runPermissionStoreContract } from '../src/testing.js';

/**
 * Real-backend coverage (testcontainers). The sqlite specs cannot see what
 * only bites in production: MySQL's `INSERT IGNORE` write path (sqlite/pg take
 * `ON CONFLICT`), MySQL's missing `CREATE INDEX IF NOT EXISTS`, Postgres strict
 * identifier behavior, and — the one every concurrency claim rests on — reads
 * from a SECOND connection while a transaction is open. sqlite pools a single
 * connection, so that read is physically impossible there.
 *
 * With Docker the FULL shared contract suite runs once per real backend
 * (fresh tables per case), plus the transaction-seam scenarios; without it
 * (a laptop with no daemon) the file skips — the default suite never
 * hard-depends on containers. CI ubuntu runners have Docker, so this is where
 * the dialect matrix actually executes.
 */

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();
const BOOT_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 60_000;

interface Backend {
  label: string;
  dialectPattern: RegExp;
  start(): Promise<{ db: Database; stop: () => Promise<void> }>;
}

function makeDatabase(client: 'pg' | 'mysql2', connection: Record<string, unknown>): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as never;
  const logger = new LoggerFactory().create();
  const emitter = new Emitter(app);
  return new Database(
    { connection: 'primary', connections: { primary: { client, connection } } },
    logger,
    emitter,
  );
}

const backends: Backend[] = [
  {
    label: 'Postgres 16',
    dialectPattern: /postgres|pg/i,
    async start() {
      const c: StartedPostgreSqlContainer = await new PostgreSqlContainer(
        'postgres:16-alpine',
      ).start();
      return {
        db: makeDatabase('pg', {
          host: c.getHost(),
          port: c.getPort(),
          user: c.getUsername(),
          password: c.getPassword(),
          database: c.getDatabase(),
        }),
        stop: () => c.stop(),
      };
    },
  },
  {
    label: 'MySQL 8',
    dialectPattern: /mysql|mariadb/i,
    async start() {
      const c: StartedMySqlContainer = await new MySqlContainer('mysql:8.0')
        .withDatabase('authz_test')
        .withRootPassword('authz-root')
        .start();
      return {
        db: makeDatabase('mysql2', {
          host: c.getHost(),
          port: c.getPort(),
          user: 'root',
          password: 'authz-root',
          database: 'authz_test',
        }),
        stop: () => c.stop(),
      };
    },
  },
];

/** Unique table set per case: fresh isolated fixtures, no shared state, no teardown race. */
let tableSeq = 0;
function nextTables(): Required<AuthzTableNames> {
  tableSeq += 1;
  const p = `authz_it_${tableSeq.toString(36)}_`;
  return {
    roles: `${p}roles`,
    permissions: `${p}permissions`,
    rolePermission: `${p}role_permission`,
    userRole: `${p}user_role`,
    userPermission: `${p}user_permission`,
  };
}

for (const backend of backends) {
  describe.runIf(DOCKER)(`LucidPermissionStore on real ${backend.label}`, () => {
    let db: Database;
    let stop: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const started = await backend.start();
      db = started.db;
      stop = started.stop;
      // The store's dialect gate (insert-ignore form, created_at type) reads
      // exactly this — a wrong string silently picks the OTHER dialect's SQL.
      expect(db.connection('primary').dialect.name).toMatch(backend.dialectPattern);
    }, BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await db?.manager.closeAll();
      await stop?.();
    }, STOP_TIMEOUT_MS);

    async function freshStore(
      userIdType: 'text' | 'integer' = 'text',
    ): Promise<LucidPermissionStore> {
      const tables = nextTables();
      await createAuthzTables(db, { tables, userIdType });
      return new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables,
        userIdType,
        autoCreateSchema: false,
      });
    }

    // Every semantic — idempotency, tenants, polymorphic types, deleteRole,
    // the (type,id)-distinct counts — runs against this real dialect too, on
    // BOTH user_id column types: behavior must not depend on the column type.
    runPermissionStoreContract(`${backend.label} via testcontainers (text)`, () =>
      freshStore('text'),
    );
    runPermissionStoreContract(`${backend.label} via testcontainers (integer)`, () =>
      freshStore('integer'),
    );

    it('ensureSchema is idempotent on this dialect (MySQL: CREATE INDEX has no IF NOT EXISTS)', async () => {
      const tables = nextTables();
      await createAuthzTables(db, { tables });
      await createAuthzTables(db, { tables });
      const s = new LucidPermissionStore(db as unknown as LucidDatabase, { tables });
      await s.createRole('twice');
      expect(await s.listRoles()).toContain('twice');
    });

    it('a host transaction is invisible to other connections until it commits', async () => {
      const s = await freshStore();
      const alice = { type: 'user', id: '1' };

      const trx = await db.transaction();
      await s.assignRole(alice, 'editor', undefined, { client: trx });
      // Through the transaction: visible...
      expect(await s.getRolesForUser(alice, undefined, { client: trx })).toContain('editor');
      // ...from a SECOND connection: NOT YET. sqlite cannot make this
      // assertion — this is the cross-connection proof the seam exists for.
      expect(await s.getRolesForUser(alice)).not.toContain('editor');
      await trx.rollback();
      expect(await s.getRolesForUser(alice)).not.toContain('editor');

      const trx2 = await db.transaction();
      await s.assignRole(alice, 'editor', undefined, { client: trx2 });
      await trx2.commit();
      expect(await s.getRolesForUser(alice)).toContain('editor');
      expect(await s.countUsersForRole('editor')).toBe(1);
    });

    it('the last-admin guard reads pending state while the root connection sees the old count', async () => {
      const s = await freshStore();
      await s.assignRole({ type: 'user', id: '1' }, 'admin');
      await s.assignRole({ type: 'user', id: '2' }, 'admin');

      const trx = await db.transaction();
      const scoped = s.withClient(trx);
      await scoped.removeRole({ type: 'user', id: '1' }, 'admin');
      expect(await scoped.countUsersForRole('admin')).toBe(1);
      // The concurrent-request view — two connections, two truths, one commit.
      expect(await s.countUsersForRole('admin')).toBe(2);
      await trx.commit();
      expect(await s.countUsersForRole('admin')).toBe(1);
    });

    it('the ambient resolveClient joins writes into the transaction, rollbacks included', async () => {
      const tables = nextTables();
      await createAuthzTables(db, { tables });
      let ambient: StoreQueryClient | undefined;
      const s = new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables,
        resolveClient: () => ambient,
      });

      // Seed through the root connection (outside any ambient scope).
      await s.givePermissionToRole('temp', 'x.view');
      await s.assignRole({ type: 'user', id: '9' }, 'temp');

      const trx = await db.transaction();
      ambient = trx;
      await s.deleteRole('temp');
      expect(await s.listRoles()).not.toContain('temp'); // the ambient scope sees the pending delete
      ambient = undefined;
      expect(await s.listRoles()).toContain('temp'); // the committed state is untouched

      await trx.rollback();
      expect(await s.getRolePermissions('temp')).toContain('x.view');
      expect(await s.countUsersForRole('temp')).toBe(1);
    });

    it('a virgin integer model preloads through the DEFAULT relation on INTEGER pivots', async () => {
      // Fixed names are safe: each backend owns a fresh container/database.
      await createAuthzTables(db, {
        tables: {
          roles: 'rel_roles',
          permissions: 'rel_permissions',
          rolePermission: 'rel_role_permission',
          userRole: 'rel_user_role',
          userPermission: 'rel_user_permission',
        },
        userIdType: 'integer',
      });
      await db.rawQuery(
        'CREATE TABLE IF NOT EXISTS rel_users (id INTEGER PRIMARY KEY, email TEXT)',
      );
      await db.rawQuery(`INSERT INTO rel_users (id, email) VALUES (42, 'a@b.c')`);
      BaseModel.$adapter = new Adapter(db);
      const s = new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables: {
          roles: 'rel_roles',
          permissions: 'rel_permissions',
          rolePermission: 'rel_role_permission',
          userRole: 'rel_user_role',
          userPermission: 'rel_user_permission',
        },
        userIdType: 'integer',
        autoCreateSchema: false,
      });
      await s.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

      const users = await RelIntUser.query().preload('roles');
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(42);
      expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    });
  });
}

/**
 * Relation models for the container backends. Fixed table names are safe —
 * each backend boots a fresh container, so there is no shared state.
 */
class RelRole extends BaseModel {
  static table = 'rel_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
}

/** Virgin integer model: plain id, DEFAULT relation, zero ceremony. */
class RelIntUser extends BaseModel {
  static table = 'rel_users';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare email: string;

  @manyToMany(() => RelRole, authzRolesRelation({ tables: { userRole: 'rel_user_role' } }))
  declare roles: ManyToMany<typeof RelRole>;
}
