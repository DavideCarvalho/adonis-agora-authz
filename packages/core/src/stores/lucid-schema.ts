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
  /**
   * Lucid's managed transaction (`db.transaction(async (trx) => …)`): commits when the callback
   * resolves, rolls back when it throws. Optional in the mirror — a client without it (e.g. a
   * migration's deferred client) just runs multi-statement writes without one.
   */
  transaction?<T>(callback: (trx: LucidQueryClient) => Promise<T>): Promise<T>;
}

/** Table-name overrides (defaults match {@link AUTHZ_TABLES}). */
export interface AuthzTableNames {
  roles?: string;
  permissions?: string;
  rolePermission?: string;
  subjectRole?: string;
  subjectPermission?: string;
}

/** The default table names for the Lucid store's RBAC schema. */
export const AUTHZ_TABLES: Required<AuthzTableNames> = {
  roles: 'authz_roles',
  permissions: 'authz_permissions',
  rolePermission: 'authz_role_permission',
  subjectRole: 'authz_subject_role',
  subjectPermission: 'authz_subject_permission',
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reject any table name that is not a bare SQL identifier (these are interpolated, never bound). */
export function assertSafeIdentifier(id: string): string {
  if (!IDENT.test(id))
    throw new Error(`@adonis-agora/authz: unsafe SQL identifier: ${JSON.stringify(id)}`);
  return id;
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Reject a `schema` that is not a plain identifier of at most 63 characters (Postgres' limit). It
 * is written into every statement, quoted, never bound.
 */
export function assertSchemaName(schema: string): string {
  if (typeof schema !== 'string' || schema.length > 63 || !SCHEMA_NAME.test(schema)) {
    throw new Error(
      `@adonis-agora/authz: invalid schema ${JSON.stringify(schema)}: use letters, digits, _ and $, not starting with a digit, at most 63 characters.`,
    );
  }
  return schema;
}

/**
 * Validate `schema` against the connection's dialect: only Postgres (a schema) and MySQL/MariaDB
 * (a database) can hold the tables elsewhere. Anything else — SQLite above all — fails instead of
 * silently ignoring the option and writing to the default schema.
 */
export function assertSchemaSupported(schema: string | undefined, dialect: string | undefined) {
  if (schema === undefined) return;
  assertSchemaName(schema);
  if (isPostgres(dialect) || isMysql(dialect)) return;
  throw new Error(
    `@adonis-agora/authz: \`schema: ${JSON.stringify(schema)}\` needs a Postgres or MySQL/MariaDB connection, but this one is ${dialect ? `"${dialect}"` : 'of an unknown dialect'}, which has no schemas. Remove \`schema\` from the store config, or point \`connection\` at Postgres/MySQL.`,
  );
}

/** Quote an identifier for the dialect: backticks on MySQL, double quotes elsewhere. */
function quoteIdent(name: string, dialect: string | undefined): string {
  return isMysql(dialect) ? `\`${name}\`` : `"${name}"`;
}

/**
 * A table reference for raw SQL: `"schema".table` (MySQL: `` `schema`.table ``) when a schema is
 * set, the bare name otherwise. The schema and the table are separate identifiers — never one
 * quoted `"schema.table"`. The table stays unquoted so it folds exactly like it does without a
 * schema (and like `CREATE TABLE` created it).
 */
export function qualifyTable(
  table: string,
  schema: string | undefined,
  dialect: string | undefined,
) {
  return schema === undefined ? table : `${quoteIdent(schema, dialect)}.${table}`;
}

/** Every table name, qualified with {@link qualifyTable}. */
export function qualifyTables(
  tables: Required<AuthzTableNames>,
  schema: string | undefined,
  dialect: string | undefined,
): Required<AuthzTableNames> {
  const out = { ...tables };
  for (const key of Object.keys(out) as (keyof AuthzTableNames)[]) {
    out[key] = qualifyTable(out[key], schema, dialect);
  }
  return out;
}

export function isPostgres(dialect: string | undefined): boolean {
  return !!dialect && /postgres|pg|redshift/i.test(dialect);
}

export function isMysql(dialect: string | undefined): boolean {
  return !!dialect && /mysql|mariadb/i.test(dialect);
}

export function isSqlite(dialect: string | undefined): boolean {
  return !!dialect && /sqlite/i.test(dialect);
}

/**
 * The `source` column of the subject-role pivot (who owns an assignment: `'manual'`, `'scim'`,
 * …). `VARCHAR(64)` keeps the widened primary key under MySQL's 3072-byte InnoDB key limit.
 */
const SOURCE_COLUMN = "source VARCHAR(64) NOT NULL DEFAULT 'manual'";

/**
 * Normalize a raw-query result into its row array. MySQL-family drivers resolve raw SELECTs to
 * the node-mysql pair `[rows, fields]` — the rows are the FIRST element, not the array itself.
 * Row objects are never arrays, so an array as the first element is the unmistakable signature
 * of that shape. Postgres resolves to `{ rows }`, sqlite to the array.
 */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0] as Record<string, unknown>[];
  }
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }
  return [];
}

/**
 * Add the `source` column to a subject-role pivot created before role sources existed —
 * NON-destructively (`ADD COLUMN … NOT NULL DEFAULT 'manual'`, so every existing assignment
 * becomes a manual one). A no-op when the column is already there.
 *
 * It does NOT widen the primary key: an old table keeps `(subject_type, subject_id, role_id,
 * tenant_id)` as its key, so the same role cannot be stored under two sources until you widen
 * it (see the "Role sources" migration notes in the docs for the exact SQL).
 */
async function ensureSourceColumn(
  db: LucidDatabase,
  name: string,
  schema: string | undefined,
  dialect: string | undefined,
) {
  const table = qualifyTable(name, schema, dialect);
  if (isPostgres(dialect)) {
    await db.rawQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${SOURCE_COLUMN}`);
    return;
  }
  if (isSqlite(dialect)) {
    const columns = rowsOf(await db.rawQuery(`PRAGMA table_info(${table})`));
    if (columns.some((c) => c.name === 'source')) return;
    await db.rawQuery(`ALTER TABLE ${table} ADD COLUMN ${SOURCE_COLUMN}`);
    return;
  }
  if (isMysql(dialect)) {
    const found = rowsOf(
      await db.rawQuery(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = ${schema === undefined ? 'DATABASE()' : '?'} AND table_name = ? AND column_name = 'source'`,
        schema === undefined ? [name] : [schema, name],
      ),
    );
    if (Number(found[0]?.n ?? 0) > 0) return;
  }
  // MySQL (checked above) and any unknown dialect: add, tolerating a concurrent/duplicate add.
  try {
    await db.rawQuery(`ALTER TABLE ${table} ADD COLUMN ${SOURCE_COLUMN}`);
  } catch (err) {
    const e = err as { code?: string; errno?: number; message?: string };
    const dup =
      e.code === 'ER_DUP_FIELDNAME' ||
      e.errno === 1060 ||
      /duplicate column|already exists/i.test(e.message ?? '');
    if (!dup) throw err;
  }
}

/** Whether `schema` exists (Postgres: a schema; MySQL: a database). */
export async function schemaExists(
  db: LucidQueryClient,
  schema: string,
  dialect: string | undefined,
): Promise<boolean> {
  const sql = isMysql(dialect)
    ? 'SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ?'
    : 'SELECT 1 AS found FROM pg_catalog.pg_namespace WHERE nspname = ?';
  return rowsOf(await db.rawQuery(sql, [schema])).length > 0;
}

/**
 * Create `schema` when it is missing (`CREATE SCHEMA` / MySQL `CREATE DATABASE`). It looks first,
 * so a role that may use an existing schema but not create one still boots. A concurrent create
 * by another replica is not an error. When the role cannot create it, fail naming the schema and
 * the grant it needs.
 */
async function ensureSchemaExists(
  db: LucidDatabase,
  schema: string,
  dialect: string | undefined,
): Promise<void> {
  if (await schemaExists(db, schema, dialect)) return;
  const mysql = isMysql(dialect);
  try {
    await db.rawQuery(
      mysql
        ? `CREATE DATABASE IF NOT EXISTS ${quoteIdent(schema, dialect)}`
        : `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema, dialect)}`,
    );
  } catch (err) {
    if (await schemaExists(db, schema, dialect).catch(() => false)) return;
    const reason = err instanceof Error ? err.message : String(err);
    const fix = mysql
      ? `create it once as an admin (CREATE DATABASE \`${schema}\`) and GRANT ALL ON \`${schema}\`.* TO the app user`
      : `create it once as an admin (CREATE SCHEMA "${schema}" AUTHORIZATION <app role>), or GRANT CREATE ON DATABASE <db> TO <app role>`;
    throw new Error(
      `@adonis-agora/authz: could not create the ${mysql ? 'database' : 'schema'} "${schema}" for the authz tables (${reason}). The connection's role needs to create it: ${fix}.`,
      { cause: err },
    );
  }
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
 * The `subject_id` column type of the subject pivots (`subjectRole`, `subjectPermission`).
 *
 * - `'text'` (default) fits every subject kind in ONE table — integer ids,
 *   UUIDs, ULIDs — because the store is polymorphic. Required for mixed apps.
 *   `authzRolesRelation()` works on it with any host key type, so this is
 *   never a correctness choice — only a storage one.
 * - `'integer'` / `'bigint'` give the pivot the host's native key type
 *   (`increments()` → `'integer'`, `bigIncrements()` → `'bigint'`): same
 *   storage and index shape as the host PK, and a foreign key to it becomes
 *   possible (MySQL requires the exact integer size for that — hence two
 *   values, not one). All subjects in the store must then hold integer ids
 *   (validated on write).
 *
 * Choose at setup: switching later is a data migration, not a flag flip.
 */
export type AuthzSubjectIdType = 'text' | 'integer' | 'bigint';

/** The DDL type behind each {@link AuthzSubjectIdType}. */
const SUBJECT_ID_COLUMN: Record<AuthzSubjectIdType, string> = {
  text: 'VARCHAR(191)',
  integer: 'INTEGER',
  bigint: 'BIGINT',
};

/**
 * Create the RBAC tables (idempotent — `CREATE TABLE IF NOT EXISTS`). Safe to call
 * from a Lucid migration `up()` or repeatedly at boot. The `created_at` column type
 * is dialect-aware (`TIMESTAMP` on Postgres, `DATETIME` elsewhere).
 *
 * @param db a Lucid `Database` or connection client
 * @param options.tables optional table-name overrides (defaults to {@link AUTHZ_TABLES})
 * @param options.schema keep the tables in this Postgres schema (MySQL: database), created if
 * missing; every statement names it. Postgres/MySQL only (see {@link assertSchemaSupported})
 * @param options.subjectIdType `'text'` (default, fits every subject kind),
 * `'integer'` or `'bigint'` (the host's native key type — see {@link AuthzSubjectIdType})
 */
export async function createAuthzTables(
  db: LucidDatabase,
  options: { tables?: AuthzTableNames; subjectIdType?: AuthzSubjectIdType; schema?: string } = {},
): Promise<void> {
  const names = resolveTables(options.tables);
  const subjectId = SUBJECT_ID_COLUMN[options.subjectIdType ?? 'text'];
  const dialect = detectDialect(db);
  const { schema } = options;
  assertSchemaSupported(schema, dialect);
  if (schema !== undefined) await ensureSchemaExists(db, schema, dialect);
  const t = qualifyTables(names, schema, dialect);
  const ts = isPostgres(dialect) ? 'TIMESTAMP' : 'DATETIME';
  const mysql = isMysql(dialect);
  const run = (sql: string) => db.rawQuery(sql);

  /**
   * MySQL has NO `CREATE INDEX IF NOT EXISTS` (MariaDB added it; MySQL 8 rejects
   * the syntax outright). So on MySQL the index DDL drops the guard and re-runs
   * are made idempotent by swallowing the duplicate-key error (ER_DUP_KEYNAME /
   * 1061) — the same outcome, reachable without version-sniffing the server.
   * Every other dialect keeps the plain `IF NOT EXISTS` form.
   */
  const createIndex = async (name: string, unique: boolean, table: string, columns: string) => {
    const guard = mysql ? '' : ' IF NOT EXISTS';
    const sql = `CREATE ${unique ? 'UNIQUE' : ''} INDEX${guard} ${name} ON ${table} (${columns})`;
    if (!mysql) {
      await run(sql);
      return;
    }
    try {
      await run(sql);
    } catch (err) {
      const e = err as { code?: string; errno?: number; message?: string };
      const dup =
        e.code === 'ER_DUP_KEYNAME' ||
        e.errno === 1061 ||
        /duplicate key name/i.test(e.message ?? '');
      if (!dup) throw err;
    }
  };

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.roles} (
      id VARCHAR(191) PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      guard VARCHAR(191),
      created_at ${ts}
    )`,
  );
  await createIndex(`${names.roles}_name_uq`, true, t.roles, 'name');

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.permissions} (
      id VARCHAR(191) PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      guard VARCHAR(191),
      created_at ${ts}
    )`,
  );
  await createIndex(`${names.permissions}_name_uq`, true, t.permissions, 'name');

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.rolePermission} (
      role_id VARCHAR(191) NOT NULL,
      permission_id VARCHAR(191) NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    )`,
  );

  // `source` is part of the key: the same (subject, role, tenant) may be held via several
  // sources (manual + SCIM), one row each. On MySQL `role_id` (always an ASCII UUID) is declared
  // ASCII so the five-column key stays under InnoDB's 3072-byte limit with utf8mb4.
  const roleIdColumn = mysql ? 'VARCHAR(191) CHARACTER SET ascii' : 'VARCHAR(191)';
  await run(
    `CREATE TABLE IF NOT EXISTS ${t.subjectRole} (
      subject_type VARCHAR(191) NOT NULL,
      subject_id ${subjectId} NOT NULL,
      role_id ${roleIdColumn} NOT NULL,
      tenant_id VARCHAR(191) NOT NULL DEFAULT '',
      ${SOURCE_COLUMN},
      PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source)
    )`,
  );
  // Tables created before role sources existed: add the column (non-destructive).
  await ensureSourceColumn(db, names.subjectRole, schema, dialect);
  await createIndex(
    `${names.subjectRole}_subject_idx`,
    false,
    t.subjectRole,
    'subject_type, subject_id',
  );

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.subjectPermission} (
      subject_type VARCHAR(191) NOT NULL,
      subject_id ${subjectId} NOT NULL,
      permission_id VARCHAR(191) NOT NULL,
      PRIMARY KEY (subject_type, subject_id, permission_id)
    )`,
  );
  await createIndex(
    `${names.subjectPermission}_subject_idx`,
    false,
    t.subjectPermission,
    'subject_type, subject_id',
  );
}

/**
 * Drop the RBAC tables (idempotent — `DROP TABLE IF EXISTS`). For a migration
 * `down()`. Dropped child-first so it is safe should a dialect enforce FKs.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.tables optional table-name overrides (defaults to {@link AUTHZ_TABLES})
 * @param options.schema the schema the tables live in (the schema itself is left in place)
 */
export async function dropAuthzTables(
  db: LucidDatabase,
  options: { tables?: AuthzTableNames; schema?: string } = {},
): Promise<void> {
  const dialect = detectDialect(db);
  assertSchemaSupported(options.schema, dialect);
  const t = qualifyTables(resolveTables(options.tables), options.schema, dialect);
  for (const table of [
    t.subjectPermission,
    t.subjectRole,
    t.rolePermission,
    t.permissions,
    t.roles,
  ]) {
    await db.rawQuery(`DROP TABLE IF EXISTS ${table}`);
  }
}
