import { randomUUID } from 'node:crypto';
import type { PermissionStore, StoreOptions, StoreQueryClient } from '../store.js';
import { GLOBAL_TENANT, normalizeTenant, type TenantScope, type UserRef } from '../user_ref.js';
import {
  AUTHZ_TABLES,
  type AuthzTableNames,
  assertSafeIdentifier,
  createAuthzTables,
  detectDialect,
  isMysql,
  type LucidDatabase,
  type LucidQueryClient,
} from './lucid-schema.js';

// Re-exported for backward compatibility: these types originated here before the
// schema was extracted into `lucid-schema.ts`. Consumers (and `factory.ts`) import
// them from `./lucid.js`.
export type {
  AuthzTableNames,
  LucidDatabase,
  LucidQueryBindings,
  LucidQueryClient,
} from './lucid-schema.js';

export interface LucidPermissionStoreOptions {
  tables?: AuthzTableNames;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use (default true). Set false when using migrations. */
  autoCreateSchema?: boolean;
  /**
   * Ambient transaction seam (the config-level wiring): called before each data
   * method, a non-nullish return runs that call's SQL on it — typically a tiny
   * AsyncLocalStorage read set up around `db.transaction`. Precedence per call:
   * explicit `opts.client` → the {@link withClient} view's client → this
   * resolver → the store's own connection. A resolver returning `undefined`
   * (no transaction active) is the normal path for reads and standalone writes.
   */
  resolveClient?: () => StoreQueryClient | undefined;
}

function toRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }
  return [];
}

/**
 * Lucid-backed {@link PermissionStore}. Uses parameterized `rawQuery` against a
 * portable schema (SQLite / Postgres / MySQL). All identifiers are validated;
 * all values are bound, never interpolated. Idempotent writes use the dialect's
 * insert-ignore form.
 *
 * Transaction seam — every data method resolves the client it runs on, most
 * local wins: `opts.client` (per-call, Lucid-style) → the client bound by
 * {@link withClient} (one injection point for a whole sequence) → the `resolveClient`
 * config (ambient context) → the store's own connection. `ensureSchema` and the
 * lazy auto-create always use the root connection; a method running on a host
 * client never touches it, so nothing waits on a transaction the host opened.
 */
export class LucidPermissionStore implements PermissionStore {
  private readonly t: Required<AuthzTableNames>;
  private readonly autoCreate: boolean;
  private readonly resolveClientFn: (() => StoreQueryClient | undefined) | undefined;
  private scopedClient: StoreQueryClient | undefined;
  private schemaReady: Promise<void> | undefined;
  private dialect: string | undefined;

  constructor(
    private readonly db: LucidDatabase,
    options: LucidPermissionStoreOptions = {},
  ) {
    this.t = { ...AUTHZ_TABLES, ...options.tables };
    for (const name of Object.values(this.t)) assertSafeIdentifier(name);
    this.autoCreate = options.autoCreateSchema !== false;
    this.resolveClientFn = options.resolveClient;
    this.dialect = detectDialect(db);
  }

  /** Bind this store's SQL to a host client (e.g. a `db.transaction` client). */
  withClient(client: StoreQueryClient): LucidPermissionStore {
    const scoped = new LucidPermissionStore(this.db, {
      tables: this.t,
      // The view must not auto-create on the root connection: while a host
      // transaction is open, DDL there would wait on it (single-connection
      // sqlite) or escape it (everywhere else). Ensure the schema before.
      autoCreateSchema: false,
      ...(this.resolveClientFn ? { resolveClient: this.resolveClientFn } : {}),
    });
    scoped.scopedClient = client;
    // Inherit the parent's already-settled/settling schema state; never re-run.
    scoped.schemaReady = this.schemaReady;
    return scoped;
  }

  /** The client this call runs on: most local wins (opts → view → resolver). */
  private active(opts?: StoreOptions): LucidQueryClient {
    return (opts?.client ??
      this.scopedClient ??
      this.resolveClientFn?.() ??
      this.db) as unknown as LucidQueryClient;
  }

  /**
   * Root-connection schema gate. When THIS call resolves to a host client, the
   * schema is the host's responsibility (ensured at boot or by migrations
   * before the transaction opened) — touching the root connection there would
   * deadlock against the open transaction on single-connection pools.
   */
  private async ready(opts?: StoreOptions): Promise<void> {
    if (opts?.client || this.scopedClient || this.resolveClientFn?.()) return;
    if (!this.autoCreate) return;
    if (!this.schemaReady) this.schemaReady = this.ensureSchema();
    return this.schemaReady;
  }

  private async run(
    sql: string,
    bindings: readonly unknown[] = [],
    opts?: StoreOptions,
  ): Promise<void> {
    await this.active(opts).rawQuery(sql, bindings);
  }

  private async query(
    sql: string,
    bindings: readonly unknown[] = [],
    opts?: StoreOptions,
  ): Promise<Record<string, unknown>[]> {
    return toRows(await this.active(opts).rawQuery(sql, bindings));
  }

  /** Dialect-correct "insert, ignore on conflict" wrapping. */
  private insertIgnore(table: string, columns: string[], placeholders: string): string {
    const cols = columns.map(assertSafeIdentifier).join(', ');
    if (isMysql(this.dialect)) {
      return `INSERT IGNORE INTO ${table} (${cols}) VALUES (${placeholders})`;
    }
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  }

  /**
   * Create the RBAC tables. Delegates to the standalone {@link createAuthzTables}
   * so the auto-create path and a migration-based one run identical DDL. Always
   * on the root connection: DDL does not belong in a transaction.
   */
  async ensureSchema(): Promise<void> {
    await createAuthzTables(this.db, { tables: this.t });
  }

  private async findRoleId(name: string, opts?: StoreOptions): Promise<string | undefined> {
    const rows = await this.query(
      `SELECT id FROM ${this.t.roles} WHERE name = ? LIMIT 1`,
      [name],
      opts,
    );
    return rows[0]?.id as string | undefined;
  }

  private async findPermissionId(name: string, opts?: StoreOptions): Promise<string | undefined> {
    const rows = await this.query(
      `SELECT id FROM ${this.t.permissions} WHERE name = ? LIMIT 1`,
      [name],
      opts,
    );
    return rows[0]?.id as string | undefined;
  }

  async createRole(name: string, opts?: StoreOptions): Promise<string> {
    await this.ready(opts);
    const existing = await this.findRoleId(name, opts);
    if (existing) return existing;
    const id = randomUUID();
    await this.run(
      this.insertIgnore(this.t.roles, ['id', 'name', 'created_at'], '?, ?, ?'),
      [id, name, new Date()],
      opts,
    );
    return (await this.findRoleId(name, opts)) ?? id;
  }

  async createPermission(name: string, opts?: StoreOptions): Promise<string> {
    await this.ready(opts);
    const existing = await this.findPermissionId(name, opts);
    if (existing) return existing;
    const id = randomUUID();
    await this.run(
      this.insertIgnore(this.t.permissions, ['id', 'name', 'created_at'], '?, ?, ?'),
      [id, name, new Date()],
      opts,
    );
    return (await this.findPermissionId(name, opts)) ?? id;
  }

  async givePermissionToRole(
    roleName: string,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void> {
    const roleId = await this.createRole(roleName, opts);
    const permissionId = await this.createPermission(permissionName, opts);
    await this.run(
      this.insertIgnore(this.t.rolePermission, ['role_id', 'permission_id'], '?, ?'),
      [roleId, permissionId],
      opts,
    );
  }

  async revokePermissionFromRole(
    roleName: string,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void> {
    await this.ready(opts);
    const roleId = await this.findRoleId(roleName, opts);
    const permissionId = await this.findPermissionId(permissionName, opts);
    if (!roleId || !permissionId) return;
    await this.run(
      `DELETE FROM ${this.t.rolePermission} WHERE role_id = ? AND permission_id = ?`,
      [roleId, permissionId],
      opts,
    );
  }

  async assignRole(
    user: UserRef,
    roleName: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<void> {
    const roleId = await this.createRole(roleName, opts);
    const tenantId = normalizeTenant(scope);
    await this.run(
      this.insertIgnore(
        this.t.userRole,
        ['user_type', 'user_id', 'role_id', 'tenant_id'],
        '?, ?, ?, ?',
      ),
      [user.type, user.id, roleId, tenantId],
      opts,
    );
  }

  async removeRole(
    user: UserRef,
    roleName: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<void> {
    await this.ready(opts);
    const roleId = await this.findRoleId(roleName, opts);
    if (!roleId) return;
    const tenantId = normalizeTenant(scope);
    await this.run(
      `DELETE FROM ${this.t.userRole} WHERE user_type = ? AND user_id = ? AND role_id = ? AND tenant_id = ?`,
      [user.type, user.id, roleId, tenantId],
      opts,
    );
  }

  async deleteRole(name: string, opts?: StoreOptions): Promise<void> {
    await this.ready(opts);
    const roleId = await this.findRoleId(name, opts);
    if (!roleId) return;
    // Child rows first so the delete is safe under a dialect that enforces FKs.
    await this.run(`DELETE FROM ${this.t.rolePermission} WHERE role_id = ?`, [roleId], opts);
    await this.run(`DELETE FROM ${this.t.userRole} WHERE role_id = ?`, [roleId], opts);
    await this.run(`DELETE FROM ${this.t.roles} WHERE id = ?`, [roleId], opts);
  }

  async giveUserPermission(
    user: UserRef,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void> {
    const permissionId = await this.createPermission(permissionName, opts);
    await this.run(
      this.insertIgnore(
        this.t.userPermission,
        ['user_type', 'user_id', 'permission_id'],
        '?, ?, ?',
      ),
      [user.type, user.id, permissionId],
      opts,
    );
  }

  async revokeUserPermission(
    user: UserRef,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void> {
    await this.ready(opts);
    const permissionId = await this.findPermissionId(permissionName, opts);
    if (!permissionId) return;
    await this.run(
      `DELETE FROM ${this.t.userPermission} WHERE user_type = ? AND user_id = ? AND permission_id = ?`,
      [user.type, user.id, permissionId],
      opts,
    );
  }

  /**
   * Tenant filter SQL + bindings. Global request (`''`) → only global rows. A
   * tenant request → global OR that tenant's rows. Aliases the user-role pivot
   * as `ur`.
   */
  private tenantClause(scope: TenantScope | undefined): { sql: string; bindings: unknown[] } {
    const requested = normalizeTenant(scope);
    if (requested === GLOBAL_TENANT) {
      return { sql: 'ur.tenant_id = ?', bindings: [GLOBAL_TENANT] };
    }
    return { sql: '(ur.tenant_id = ? OR ur.tenant_id = ?)', bindings: [GLOBAL_TENANT, requested] };
  }

  async getRolesForUser(
    user: UserRef,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<string[]> {
    await this.ready(opts);
    const tenant = this.tenantClause(scope);
    const rows = await this.query(
      `SELECT DISTINCT r.name AS name
       FROM ${this.t.userRole} ur
       JOIN ${this.t.roles} r ON r.id = ur.role_id
       WHERE ur.user_type = ? AND ur.user_id = ? AND ${tenant.sql}`,
      [user.type, user.id, ...tenant.bindings],
      opts,
    );
    return rows.map((r) => r.name as string);
  }

  async getUsersForRole(
    role: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<UserRef[]> {
    await this.ready(opts);
    const tenant = this.tenantClause(scope);
    const rows = await this.query(
      `SELECT DISTINCT ur.user_type AS user_type, ur.user_id AS user_id
       FROM ${this.t.userRole} ur
       JOIN ${this.t.roles} r ON r.id = ur.role_id
       WHERE r.name = ? AND ${tenant.sql}`,
      [role, ...tenant.bindings],
      opts,
    );
    return rows.map((r) => ({ type: r.user_type as string, id: String(r.user_id) }));
  }

  async countUsersForRole(role: string, scope?: TenantScope, opts?: StoreOptions): Promise<number> {
    await this.ready(opts);
    const tenant = this.tenantClause(scope);
    // DISTINCT over (user_type, user_id) in a subquery, NOT COUNT(DISTINCT
    // user_id): the store is polymorphic, and two subject TYPES sharing one id
    // string are two members — a type-blind count would disagree with
    // getUsersForRole. The dialects differ on row-value distinct support, so
    // the derived table is the portable form.
    const rows = await this.query(
      `SELECT COUNT(*) AS total
       FROM (
         SELECT DISTINCT ur.user_type AS ut, ur.user_id AS uid
         FROM ${this.t.userRole} ur
         JOIN ${this.t.roles} r ON r.id = ur.role_id
         WHERE r.name = ? AND ${tenant.sql}
       ) AS counted`,
      [role, ...tenant.bindings],
      opts,
    );
    return Number(rows[0]?.total ?? 0);
  }

  async countUsersByRole(
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<Record<string, number>> {
    await this.ready(opts);
    const tenant = this.tenantClause(scope);
    // LEFT JOIN from the roles side (tenant filter in the ON clause) so a role
    // nobody holds still appears — with 0: the inner DISTINCT leaves ut/uid
    // NULL for it and COUNT(ut) skips nulls. Members are counted per
    // (user_type, user_id) subject — the same polymorphic key as getUsersForRole.
    const rows = await this.query(
      `SELECT d.name AS name, COUNT(d.ut) AS total
       FROM (
         SELECT DISTINCT r.name AS name, ur.user_type AS ut, ur.user_id AS uid
         FROM ${this.t.roles} r
         LEFT JOIN ${this.t.userRole} ur ON ur.role_id = r.id AND ${tenant.sql}
       ) AS d
       GROUP BY d.name`,
      tenant.bindings,
      opts,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.name as string] = Number(row.total ?? 0);
    return counts;
  }

  async getPermissionsForUser(
    user: UserRef,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<string[]> {
    await this.ready(opts);
    const tenant = this.tenantClause(scope);
    const result = new Set<string>();

    const roleDerived = await this.query(
      `SELECT DISTINCT p.name AS name
       FROM ${this.t.userRole} ur
       JOIN ${this.t.rolePermission} rp ON rp.role_id = ur.role_id
       JOIN ${this.t.permissions} p ON p.id = rp.permission_id
       WHERE ur.user_type = ? AND ur.user_id = ? AND ${tenant.sql}`,
      [user.type, user.id, ...tenant.bindings],
      opts,
    );
    for (const row of roleDerived) result.add(row.name as string);

    const direct = await this.query(
      `SELECT p.name AS name
       FROM ${this.t.userPermission} up
       JOIN ${this.t.permissions} p ON p.id = up.permission_id
       WHERE up.user_type = ? AND up.user_id = ?`,
      [user.type, user.id],
      opts,
    );
    for (const row of direct) result.add(row.name as string);

    return [...result];
  }

  async userHasPermission(
    user: UserRef,
    permission: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<boolean> {
    await this.ready(opts);
    const tenant = this.tenantClause(scope);
    const roleHit = await this.query(
      `SELECT 1 AS hit
       FROM ${this.t.userRole} ur
       JOIN ${this.t.rolePermission} rp ON rp.role_id = ur.role_id
       JOIN ${this.t.permissions} p ON p.id = rp.permission_id
       WHERE ur.user_type = ? AND ur.user_id = ? AND p.name = ? AND ${tenant.sql}
       LIMIT 1`,
      [user.type, user.id, permission, ...tenant.bindings],
      opts,
    );
    if (roleHit.length > 0) return true;

    const directHit = await this.query(
      `SELECT 1 AS hit
       FROM ${this.t.userPermission} up
       JOIN ${this.t.permissions} p ON p.id = up.permission_id
       WHERE up.user_type = ? AND up.user_id = ? AND p.name = ?
       LIMIT 1`,
      [user.type, user.id, permission],
      opts,
    );
    return directHit.length > 0;
  }

  async listRoles(opts?: StoreOptions): Promise<string[]> {
    await this.ready(opts);
    const rows = await this.query(`SELECT name FROM ${this.t.roles} ORDER BY name`, [], opts);
    return rows.map((r) => r.name as string);
  }

  async listPermissions(opts?: StoreOptions): Promise<string[]> {
    await this.ready(opts);
    const rows = await this.query(`SELECT name FROM ${this.t.permissions} ORDER BY name`, [], opts);
    return rows.map((r) => r.name as string);
  }

  async getRolePermissions(roleName: string, opts?: StoreOptions): Promise<string[]> {
    await this.ready(opts);
    const roleId = await this.findRoleId(roleName, opts);
    if (!roleId) return [];
    const rows = await this.query(
      `SELECT p.name AS name
       FROM ${this.t.rolePermission} rp
       JOIN ${this.t.permissions} p ON p.id = rp.permission_id
       WHERE rp.role_id = ?
       ORDER BY p.name`,
      [roleId],
      opts,
    );
    return rows.map((r) => r.name as string);
  }
}
