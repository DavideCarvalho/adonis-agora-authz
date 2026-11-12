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
import { LucidPermissionStore } from '../src/stores/lucid.js';
import type { AuthzTableNames, LucidDatabase } from '../src/stores/lucid-schema.js';
import { AUTHZ_TABLES, createAuthzTables } from '../src/stores/lucid-schema.js';
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
    subjectRole: `${p}subject_role`,
    subjectPermission: `${p}subject_permission`,
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
      subjectIdType: 'text' | 'integer' = 'text',
    ): Promise<LucidPermissionStore> {
      const tables = nextTables();
      await createAuthzTables(db, { tables, subjectIdType });
      return new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables,
        subjectIdType,
        autoCreateSchema: false,
      });
    }

    // Every semantic — idempotency, tenants, polymorphic types, deleteRole,
    // the (type,id)-distinct counts — runs against this real dialect too, on
    // BOTH subject_id column types: behavior must not depend on the column type.
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
      expect(await s.getRolesForSubject(alice, undefined, { client: trx })).toContain('editor');
      // ...from a SECOND connection: NOT YET. sqlite cannot make this
      // assertion — this is the cross-connection proof the seam exists for.
      expect(await s.getRolesForSubject(alice)).not.toContain('editor');
      await trx.rollback();
      expect(await s.getRolesForSubject(alice)).not.toContain('editor');

      const trx2 = await db.transaction();
      await s.assignRole(alice, 'editor', undefined, { client: trx2 });
      await trx2.commit();
      expect(await s.getRolesForSubject(alice)).toContain('editor');
      expect(await s.countSubjectsForRole('editor')).toBe(1);
    });

    it('the last-admin guard reads pending state while the root connection sees the old count', async () => {
      const s = await freshStore();
      await s.assignRole({ type: 'user', id: '1' }, 'admin');
      await s.assignRole({ type: 'user', id: '2' }, 'admin');

      const trx = await db.transaction();
      const scoped = s.withClient(trx);
      await scoped.removeRole({ type: 'user', id: '1' }, 'admin');
      expect(await scoped.countSubjectsForRole('admin')).toBe(1);
      // The concurrent-request view — two connections, two truths, one commit.
      expect(await s.countSubjectsForRole('admin')).toBe(2);
      await trx.commit();
      expect(await s.countSubjectsForRole('admin')).toBe(1);
    });

    it('role sources: upgrades a pre-sources pivot with the documented key-widening SQL', async () => {
      const tables = nextTables();
      await createAuthzTables(db, { tables });
      const pivot = tables.subjectRole;
      // Recreate the pivot as it was before role sources existed.
      await db.rawQuery(`DROP TABLE ${pivot}`);
      await db.rawQuery(
        `CREATE TABLE ${pivot} (
          subject_type VARCHAR(191) NOT NULL,
          subject_id VARCHAR(191) NOT NULL,
          role_id VARCHAR(191) NOT NULL,
          tenant_id VARCHAR(191) NOT NULL DEFAULT '',
          PRIMARY KEY (subject_type, subject_id, role_id, tenant_id)
        )`,
      );
      const s = new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables,
        autoCreateSchema: false,
      });
      const alice = { type: 'user', id: '1' };
      await db.rawQuery(`INSERT INTO ${pivot} (subject_type, subject_id, role_id, tenant_id)
        VALUES ('user', '1', '${await s.createRole('editor')}', '')`);

      // 1. ensureSchema adds the column non-destructively (and is idempotent).
      await s.ensureSchema();
      await s.ensureSchema();
      expect(await s.getRoleAssignments(alice)).toEqual([
        { role: 'editor', source: 'manual', tenantId: null },
      ]);

      // 2. The documented SQL (docs/roles.mdx, "Role sources") widens the key.
      const widen = backend.dialectPattern.test('postgres')
        ? [
            'ALTER TABLE authz_subject_role DROP CONSTRAINT authz_subject_role_pkey',
            'ALTER TABLE authz_subject_role ADD PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source)',
          ]
        : [
            `ALTER TABLE authz_subject_role
               MODIFY role_id VARCHAR(191) CHARACTER SET ascii NOT NULL,
               DROP PRIMARY KEY,
               ADD PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source)`,
          ];
      for (const sql of widen) await db.rawQuery(sql.replaceAll('authz_subject_role', pivot));

      await s.assignRole(alice, 'editor', { source: 'scim' });
      await s.setSubjectRoles(alice, ['editor', 'auditor'], { source: 'scim' });
      await s.removeRole(alice, 'editor', { source: 'manual' });
      expect(await s.getRoleAssignments(alice)).toEqual([
        { role: 'auditor', source: 'scim', tenantId: null },
        { role: 'editor', source: 'scim', tenantId: null },
      ]);
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
      expect(await s.countSubjectsForRole('temp')).toBe(1);
    });

    it('a virgin integer model preloads through the DEFAULT relation on INTEGER pivots', async () => {
      // Fixed names are safe: each backend owns a fresh container/database.
      await createAuthzTables(db, {
        tables: {
          roles: 'rel_roles',
          permissions: 'rel_permissions',
          rolePermission: 'rel_role_permission',
          subjectRole: 'rel_subject_role',
          subjectPermission: 'rel_subject_permission',
        },
        subjectIdType: 'integer',
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
          subjectRole: 'rel_subject_role',
          subjectPermission: 'rel_subject_permission',
        },
        subjectIdType: 'integer',
        autoCreateSchema: false,
      });
      await s.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

      const users = await RelIntUser.query().preload('roles');
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(42);
      expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
      // Native-typed pivot: `whereHas` compares integer to integer on every dialect.
      const has = await RelIntUser.query().whereHas('roles', (q) => q.where('name', 'COORDINATOR'));
      expect(has.map((u) => u.id)).toEqual([42]);
    });

    it('an integer model preloads through the DEFAULT relation on TEXT (default) pivots', async () => {
      // The zero-config path every fresh install lands on: increments() host,
      // polymorphic TEXT pivot, nothing declared on the model. The relation
      // normalizes both the bound key and the distribution — on every dialect.
      const tables = {
        roles: 'txt_roles',
        permissions: 'txt_permissions',
        rolePermission: 'txt_role_permission',
        subjectRole: 'txt_subject_role',
        subjectPermission: 'txt_subject_permission',
      };
      await createAuthzTables(db, { tables });
      await db.rawQuery(
        'CREATE TABLE IF NOT EXISTS txt_users (id INTEGER PRIMARY KEY, email TEXT)',
      );
      await db.rawQuery(`INSERT INTO txt_users (id, email) VALUES (7, 'a@b.c'), (42, 'b@b.c')`);
      BaseModel.$adapter = new Adapter(db);
      const s = new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables,
        autoCreateSchema: false,
      });
      await s.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');
      await s.assignRole({ type: 'user', id: '7' }, 'VIEWER');
      await s.assignRole({ type: 'team', id: '7' }, 'LEAK'); // other subject kind, same id

      const users = await TxtIntUser.query().orderBy('id').preload('roles');
      expect(users.map((u) => [u.id, u.roles.map((r) => r.name)])).toEqual([
        [7, ['VIEWER']],
        [42, ['COORDINATOR']],
      ]);
      // And the single-instance paths.
      const one = await TxtIntUser.findOrFail(42);
      await one.load('roles');
      expect(one.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
      expect((await one.related('roles').query()).map((r) => r.name)).toEqual(['COORDINATOR']);

      // The one thing the relation cannot normalize: `has`/`whereHas` compare
      // the REAL columns in SQL (`users.id = subject_role.subject_id`). MySQL
      // coerces; Postgres refuses `integer = character varying` — LOUDLY, which
      // is the documented reason to pick `subjectIdType` on Postgres.
      const whereHas = TxtIntUser.query().whereHas('roles', (q) => q.where('name', 'VIEWER'));
      if (backend.dialectPattern.test('postgres')) {
        await expect(whereHas).rejects.toThrow(
          /operator does not exist: integer = character varying/,
        );
      } else {
        expect((await whereHas).map((u) => u.id)).toEqual([7]);
      }
    });

    describe('with `schema` (tables outside the default schema)', () => {
      const isPg = backend.dialectPattern.test('postgres');
      let schemaSeq = 0;
      const nextSchema = () => {
        schemaSeq += 1;
        return `authz_sch_${schemaSeq}`;
      };
      /** The tables that exist in `schema` (Postgres schema / MySQL database). */
      async function tablesIn(schema: string): Promise<string[]> {
        const result = await db.rawQuery(
          'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
          [schema],
        );
        const rows = (Array.isArray(result) ? result[0] : result.rows) as { name: string }[];
        return rows.map((r) => r.name).sort();
      }
      const defaultSchema = isPg ? 'public' : 'authz_test';

      async function freshSchemaStore(): Promise<LucidPermissionStore> {
        const schema = nextSchema();
        const tables = nextTables();
        await createAuthzTables(db, { tables, schema });
        return new LucidPermissionStore(db as unknown as LucidDatabase, {
          tables,
          schema,
          autoCreateSchema: false,
        });
      }

      runPermissionStoreContract(`${backend.label} in a schema`, freshSchemaStore);

      it('auto-create makes the schema and the tables there, none in the default schema', async () => {
        const schema = nextSchema();
        const s = new LucidPermissionStore(db as unknown as LucidDatabase, { schema });
        await s.givePermissionToRole('editor', 'posts.edit');
        await s.assignRole({ type: 'user', id: '1' }, 'editor');
        expect(await s.subjectHasPermission({ type: 'user', id: '1' }, 'posts.edit')).toBe(true);
        expect(await tablesIn(schema)).toEqual(Object.values(AUTHZ_TABLES).sort());
        expect(
          (await tablesIn(defaultSchema)).filter((t) =>
            /^authz_(roles|permissions|role_permission|subject_role|subject_permission)$/.test(t),
          ),
        ).toEqual([]);
        // Idempotent re-run, also through the standalone helper.
        await s.ensureSchema();
        await createAuthzTables(db, { schema });
        expect(await s.inspectSchema()).toEqual({
          schema,
          exists: true,
          missingTables: [],
          writable: true,
        });
      });

      it('two installs with the same table names in two schemas do not see each other', async () => {
        const a = new LucidPermissionStore(db as unknown as LucidDatabase, {
          schema: nextSchema(),
        });
        const b = new LucidPermissionStore(db as unknown as LucidDatabase, {
          schema: nextSchema(),
        });
        await a.createRole('only-a');
        await b.createRole('only-b');
        expect(await a.listRoles()).toEqual(['only-a']);
        expect(await b.listRoles()).toEqual(['only-b']);
      });

      it("joins the app's transaction (opts.client, withClient, resolveClient), rollbacks included", async () => {
        const s = await freshSchemaStore();
        const alice = { type: 'user', id: '1' };
        const trx = await db.transaction();
        await s.assignRole(alice, 'editor', undefined, { client: trx });
        await s.withClient(trx).givePermissionToRole('editor', 'posts.edit');
        expect(await s.getRolesForSubject(alice, undefined, { client: trx })).toEqual(['editor']);
        expect(await s.getRolesForSubject(alice)).toEqual([]);
        await trx.rollback();
        expect(await s.listRoles()).toEqual([]);

        let ambient: StoreQueryClient | undefined;
        const tables = nextTables();
        const schema = nextSchema();
        await createAuthzTables(db, { tables, schema });
        const amb = new LucidPermissionStore(db as unknown as LucidDatabase, {
          tables,
          schema,
          resolveClient: () => ambient,
        });
        // First use outside any transaction: the lazy schema gate settles on the root connection.
        expect(await amb.listRoles()).toEqual([]);
        const trx2 = await db.transaction();
        ambient = trx2;
        await amb.setSubjectRoles(alice, ['a', 'b']);
        ambient = undefined;
        expect(await amb.getRolesForSubject(alice)).toEqual([]);
        await trx2.commit();
        expect((await amb.getRolesForSubject(alice)).sort()).toEqual(['a', 'b']);
      });

      it('self-repair adds the source column to an old pivot inside the schema', async () => {
        const schema = nextSchema();
        const tables = nextTables();
        await createAuthzTables(db, { tables, schema });
        const q = isPg
          ? `"${schema}".${tables.subjectRole}`
          : `\`${schema}\`.${tables.subjectRole}`;
        await db.rawQuery(`DROP TABLE ${q}`);
        await db.rawQuery(
          `CREATE TABLE ${q} (
            subject_type VARCHAR(191) NOT NULL,
            subject_id VARCHAR(191) NOT NULL,
            role_id VARCHAR(191) NOT NULL,
            tenant_id VARCHAR(191) NOT NULL DEFAULT '',
            PRIMARY KEY (subject_type, subject_id, role_id, tenant_id)
          )`,
        );
        // A same-named table WITH the column in the default schema must not fool the check.
        await createAuthzTables(db, { tables });
        const s = new LucidPermissionStore(db as unknown as LucidDatabase, { tables, schema });
        await s.ensureSchema();
        await s.assignRole({ type: 'user', id: '1' }, 'editor');
        expect(await s.getRoleAssignments({ type: 'user', id: '1' })).toEqual([
          { role: 'editor', source: 'manual', tenantId: null },
        ]);
      });

      it('the roles relation preloads through the schema-qualified pivot', async () => {
        const schema = 'authz_rel';
        await createAuthzTables(db, { schema });
        await db.rawQuery(
          'CREATE TABLE IF NOT EXISTS sch_users (id INTEGER PRIMARY KEY, email TEXT)',
        );
        await db.rawQuery(`INSERT INTO sch_users (id, email) VALUES (5, 'a@b.c'), (6, 'b@b.c')`);
        BaseModel.$adapter = new Adapter(db);
        const s = new LucidPermissionStore(db as unknown as LucidDatabase, { schema });
        await s.assignRole({ type: 'user', id: '5' }, 'EDITOR');
        await s.assignRole({ type: 'user', id: '6' }, 'VIEWER', { tenantId: 't1' });

        const users = await SchemaUser.query().orderBy('id').preload('roles');
        expect(users.map((u) => [u.id, u.roles.map((r) => r.name)])).toEqual([
          [5, ['EDITOR']],
          [6, []],
        ]);
        const tenant = await SchemaUser.query().orderBy('id').preload('tenantRoles');
        expect(tenant.map((u) => u.tenantRoles.map((r) => r.name))).toEqual([
          ['EDITOR'],
          ['VIEWER'],
        ]);
        const one = await SchemaUser.findOrFail(5);
        expect((await one.related('roles').query()).map((r) => r.name)).toEqual(['EDITOR']);
        if (!isPg) {
          // Postgres refuses integer = varchar in has/whereHas (see the TEXT-pivot test above).
          const has = await SchemaUser.query().whereHas('roles', (q) => q.where('name', 'EDITOR'));
          expect(has.map((u) => u.id)).toEqual([5]);
        }
      });

      it('inspectSchema reports a missing schema and missing tables', async () => {
        const schema = nextSchema();
        const s = new LucidPermissionStore(db as unknown as LucidDatabase, {
          schema,
          autoCreateSchema: false,
        });
        expect(await s.inspectSchema()).toMatchObject({ exists: false, writable: undefined });
        await db.rawQuery(isPg ? `CREATE SCHEMA "${schema}"` : `CREATE DATABASE \`${schema}\``);
        const found = await s.inspectSchema();
        expect(found).toMatchObject({ exists: true, writable: undefined });
        expect(found?.missingTables.sort()).toEqual(Object.values(AUTHZ_TABLES).sort());
      });

      it.runIf(isPg)(
        'a role that cannot create the schema fails with the grant it needs; one that cannot write is reported',
        async () => {
          await db.rawQuery(
            "DO $$ BEGIN CREATE ROLE authz_limited LOGIN PASSWORD 'limited'; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
          );
          const conn = db.connection('primary').getWriteClient().client
            .connectionSettings as Record<string, unknown>;
          const limited = makeDatabase('pg', {
            ...conn,
            user: 'authz_limited',
            password: 'limited',
          });
          try {
            await db.rawQuery(`REVOKE CREATE ON DATABASE ${String(conn.database)} FROM PUBLIC`);
            const store = new LucidPermissionStore(limited as unknown as LucidDatabase, {
              schema: 'authz_nogrant',
            });
            await expect(store.listRoles()).rejects.toThrow(
              /could not create the schema "authz_nogrant".*CREATE SCHEMA "authz_nogrant" AUTHORIZATION/,
            );

            // An admin made the schema and tables, granted only read: the doctor probe says so.
            await createAuthzTables(db, { schema: 'authz_readonly' });
            await db.rawQuery('GRANT USAGE ON SCHEMA "authz_readonly" TO authz_limited');
            await db.rawQuery(
              'GRANT SELECT ON ALL TABLES IN SCHEMA "authz_readonly" TO authz_limited',
            );
            const readonly = new LucidPermissionStore(limited as unknown as LucidDatabase, {
              schema: 'authz_readonly',
              // Postgres checks CREATE on the schema even for CREATE TABLE IF NOT EXISTS.
              autoCreateSchema: false,
            });
            expect(await readonly.listRoles()).toEqual([]);
            expect(await readonly.inspectSchema()).toMatchObject({
              exists: true,
              missingTables: [],
              writable: false,
            });
          } finally {
            await limited.manager.closeAll();
          }
        },
      );
    });

    it('a bigint model preloads through the DEFAULT relation on BIGINT pivots', async () => {
      // Postgres hands `bigint` back as a STRING, so a bigIncrements() host
      // would compare `'42' === 42` in Lucid's own distribution — and an id
      // beyond int4 would not even fit an INTEGER pivot. `'bigint'` sizes the
      // column like the host; the relation's normalization does the rest.
      // (The id stays below 2^53: mysql2 returns BIGINT as a JS number.)
      const tables = {
        roles: 'big_roles',
        permissions: 'big_permissions',
        rolePermission: 'big_role_permission',
        subjectRole: 'big_subject_role',
        subjectPermission: 'big_subject_permission',
      };
      await createAuthzTables(db, { tables, subjectIdType: 'bigint' });
      await db.rawQuery('CREATE TABLE IF NOT EXISTS big_users (id BIGINT PRIMARY KEY, email TEXT)');
      await db.rawQuery(`INSERT INTO big_users (id, email) VALUES (4294967342, 'a@b.c')`);
      BaseModel.$adapter = new Adapter(db);
      const s = new LucidPermissionStore(db as unknown as LucidDatabase, {
        tables,
        subjectIdType: 'bigint',
        autoCreateSchema: false,
      });
      await s.assignRole({ type: 'user', id: '4294967342' }, 'COORDINATOR');

      const users = await BigIntUser.query().preload('roles');
      expect(users).toHaveLength(1);
      expect(String(users[0]!.id)).toBe('4294967342');
      expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    });
  });
}

/** A host in the default schema whose roles live in the `authz_rel` schema. */
class SchemaRole extends BaseModel {
  static table = 'authz_rel.authz_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
}

class SchemaUser extends BaseModel {
  static table = 'sch_users';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare email: string;

  @manyToMany(() => SchemaRole, authzRolesRelation({ schema: 'authz_rel' }))
  declare roles: ManyToMany<typeof SchemaRole>;

  @manyToMany(() => SchemaRole, authzRolesRelation({ schema: 'authz_rel', tenantId: 't1' }))
  declare tenantRoles: ManyToMany<typeof SchemaRole>;
}

/** TEXT-pivot integer host: nothing but the PK and the relation. */
class TxtIntUser extends BaseModel {
  static table = 'txt_users';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare email: string;

  @manyToMany(() => TxtRole, authzRolesRelation({ tables: { subjectRole: 'txt_subject_role' } }))
  declare roles: ManyToMany<typeof TxtRole>;
}

class TxtRole extends BaseModel {
  static table = 'txt_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
}

/** bigIncrements() host over BIGINT pivots. */
class BigIntUser extends BaseModel {
  static table = 'big_users';

  @column({ isPrimary: true })
  declare id: number | string;

  @column()
  declare email: string;

  @manyToMany(() => BigRole, authzRolesRelation({ tables: { subjectRole: 'big_subject_role' } }))
  declare roles: ManyToMany<typeof BigRole>;
}

class BigRole extends BaseModel {
  static table = 'big_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
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

  @manyToMany(() => RelRole, authzRolesRelation({ tables: { subjectRole: 'rel_subject_role' } }))
  declare roles: ManyToMany<typeof RelRole>;
}
