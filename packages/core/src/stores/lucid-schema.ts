/**
 * The RBAC schema for the Lucid store, as standalone functions.
 *
 * By default {@link LucidPermissionStore} auto-creates these tables on first use
 * (`autoCreateSchema`, the ecosystem convention — a lib owns its own schema). An
 * app that prefers explicit control sets `autoCreateSchema: false` and calls
 * {@link createAuthzTables} from a Lucid migration instead, mirroring
 * `@adonis-agora/durable`'s `createDurableTables`. Both paths run the SAME DDL —
 * the store's `ensureSchema` delegates here — so they never drift.
 *
 * The DDL is portable `rawQuery` (`CREATE TABLE IF NOT EXISTS`), not the Knex
 * schema builder: it is dialect-aware for SQLite / Postgres / MySQL and keeps the
 * `@adonisjs/lucid` coupling to the `rawQuery` surface, the same posture the store
 * takes.
 */

/**
 * The bindings a Lucid `rawQuery` accepts: positional values, or a named map.
 *
 * Mirrors Lucid's own `RawQueryBindings` (`StrictValues[] | Dictionary<StrictValues, string>`)
 * WIDELY rather than narrowly, and that direction is load-bearing. A structural mirror is only
 * useful if the real client satisfies it, and parameter positions make that a question of
 * assignability into this type: Lucid's union must fit here, not the other way round. Declaring
 * just `readonly unknown[]` left no direction that worked — `readonly unknown[]` is not assignable
 * to the mutable `StrictValues[]`, and the named-map branch is not an array at all — so no real
 * query client satisfied {@link LucidQueryClient}, and the published migration stub did not compile
 * in a consumer app even though every check inside this repo passed.
 */
export type LucidQueryBindings = readonly unknown[] | Record<string, unknown>;

/**
 * The slice of a Lucid query client the schema functions rely on. Both the root
 * `Database` and a connection client satisfy it, so we depend on the surface
 * rather than a concrete Lucid type — keeping the optional-peer coupling minimal.
 *
 * `rawQuery` is declared as a METHOD (not a function-typed property) on purpose: methods are
 * checked bivariantly, which is what lets a real Lucid client — whose signature is more specific
 * than this mirror — satisfy the interface under `strictFunctionTypes`.
 */
export interface LucidQueryClient {
  rawQuery(sql: string, bindings?: LucidQueryBindings): Promise<unknown>;
}

/**
 * A Lucid `Database` / connection / query client. Dialect detection accepts both
 * shapes the lib is handed: the root `Database` exposes the dialect via
 * `connection().dialect`, while a migration's deferred query client
 * (`this.defer((db) => …)`) exposes `dialect` directly.
 */
export interface LucidDatabase extends LucidQueryClient {
  dialect?: { name?: string };
  connection?(name?: string): { dialect?: { name?: string } };
}

/** Table-name overrides (defaults match {@link AUTHZ_TABLES}). */
export interface AuthzTableNames {
  roles?: string;
  permissions?: string;
  rolePermission?: string;
  userRole?: string;
  userPermission?: string;
}

/** The default table names for the Lucid store's RBAC schema. */
export const AUTHZ_TABLES: Required<AuthzTableNames> = {
  roles: 'authz_roles',
  permissions: 'authz_permissions',
  rolePermission: 'authz_role_permission',
  userRole: 'authz_user_role',
  userPermission: 'authz_user_permission',
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reject any table name that is not a bare SQL identifier (these are interpolated, never bound). */
export function assertSafeIdentifier(id: string): string {
  if (!IDENT.test(id))
    throw new Error(`@adonis-agora/authz: unsafe SQL identifier: ${JSON.stringify(id)}`);
  return id;
}

export function isPostgres(dialect: string | undefined): boolean {
  return !!dialect && /postgres|pg|redshift/i.test(dialect);
}

export function isMysql(dialect: string | undefined): boolean {
  return !!dialect && /mysql|mariadb/i.test(dialect);
}

/**
 * Best-effort dialect name from a Lucid client; `undefined` when it can't be read.
 * Reads a directly-exposed `dialect` first (a deferred migration query client), then
 * falls back to `connection().dialect` (the root `Database`).
 */
export function detectDialect(db: LucidDatabase): string | undefined {
  try {
    const direct = db.dialect?.name;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    return db.connection?.()?.dialect?.name;
  } catch {
    return undefined;
  }
}

/** Resolve the effective table names, validating each identifier. */
function resolveTables(tables: AuthzTableNames | undefined): Required<AuthzTableNames> {
  const t = { ...AUTHZ_TABLES, ...tables };
  for (const name of Object.values(t)) assertSafeIdentifier(name);
  return t;
}

/**
 * Create the RBAC tables (idempotent — `CREATE TABLE IF NOT EXISTS`). Safe to call
 * from a Lucid migration `up()` or repeatedly at boot. The `created_at` column type
 * is dialect-aware (`TIMESTAMP` on Postgres, `DATETIME` elsewhere).
 *
 * @param db a Lucid `Database` or connection client
 * @param options.tables optional table-name overrides (defaults to {@link AUTHZ_TABLES})
 */
export async function createAuthzTables(
  db: LucidDatabase,
  options: { tables?: AuthzTableNames } = {},
): Promise<void> {
  const t = resolveTables(options.tables);
  const ts = isPostgres(detectDialect(db)) ? 'TIMESTAMP' : 'DATETIME';
  const run = (sql: string) => db.rawQuery(sql);

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.roles} (
      id VARCHAR(191) PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      guard VARCHAR(191),
      created_at ${ts}
    )`,
  );
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ${t.roles}_name_uq ON ${t.roles} (name)`);

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.permissions} (
      id VARCHAR(191) PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      guard VARCHAR(191),
      created_at ${ts}
    )`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t.permissions}_name_uq ON ${t.permissions} (name)`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.rolePermission} (
      role_id VARCHAR(191) NOT NULL,
      permission_id VARCHAR(191) NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.userRole} (
      user_type VARCHAR(191) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      role_id VARCHAR(191) NOT NULL,
      tenant_id VARCHAR(191) NOT NULL DEFAULT '',
      PRIMARY KEY (user_type, user_id, role_id, tenant_id)
    )`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS ${t.userRole}_user_idx ON ${t.userRole} (user_type, user_id)`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.userPermission} (
      user_type VARCHAR(191) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      permission_id VARCHAR(191) NOT NULL,
      PRIMARY KEY (user_type, user_id, permission_id)
    )`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS ${t.userPermission}_user_idx ON ${t.userPermission} (user_type, user_id)`,
  );
}

/**
 * Drop the RBAC tables (idempotent — `DROP TABLE IF EXISTS`). For a migration
 * `down()`. Dropped child-first so it is safe should a dialect enforce FKs.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.tables optional table-name overrides (defaults to {@link AUTHZ_TABLES})
 */
export async function dropAuthzTables(
  db: LucidDatabase,
  options: { tables?: AuthzTableNames } = {},
): Promise<void> {
  const t = resolveTables(options.tables);
  for (const table of [t.userPermission, t.userRole, t.rolePermission, t.permissions, t.roles]) {
    await db.rawQuery(`DROP TABLE IF EXISTS ${table}`);
  }
}
