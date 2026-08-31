import { randomUUID } from 'node:crypto';
import type { PermissionStore } from '../store.js';
import { GLOBAL_TENANT, normalizeTenant, type TenantScope, type UserRef } from '../user_ref.js';
import {
  AUTHZ_TABLES,
  type AuthzTableNames,
  assertSafeIdentifier,
  createAuthzTables,
  detectDialect,
  isMysql,
  type LucidDatabase,
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
 */
export class LucidPermissionStore implements PermissionStore {
  private readonly t: Required<AuthzTableNames>;
  private readonly autoCreate: boolean;
  private schemaReady: Promise<void> | undefined;
  private dialect: string | undefined;

  constructor(
    private readonly db: LucidDatabase,
    options: LucidPermissionStoreOptions = {},
  ) {
    this.t = { ...AUTHZ_TABLES, ...options.tables };
    for (const name of Object.values(this.t)) assertSafeIdentifier(name);
    this.autoCreate = options.autoCreateSchema !== false;
    this.dialect = detectDialect(db);
  }

  private async ready(): Promise<void> {
    if (!this.autoCreate) return;
    if (!this.schemaReady) this.schemaReady = this.ensureSchema();
    return this.schemaReady;
  }

  private async run(sql: string, bindings: readonly unknown[] = []): Promise<void> {
    await this.db.rawQuery(sql, bindings);
  }

  private async query(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    return toRows(await this.db.rawQuery(sql, bindings));
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
   * so the auto-create path and a migration-based one run identical DDL.
   */
  async ensureSchema(): Promise<void> {
    await createAuthzTables(this.db, { tables: this.t });
  }

  private async findRoleId(name: string): Promise<string | undefined> {
    const rows = await this.query(`SELECT id FROM ${this.t.roles} WHERE name = ? LIMIT 1`, [name]);
    return rows[0]?.id as string | undefined;
  }

  private async findPermissionId(name: string): Promise<string | undefined> {
    const rows = await this.query(`SELECT id FROM ${this.t.permissions} WHERE name = ? LIMIT 1`, [
      name,
    ]);
    return rows[0]?.id as string | undefined;
  }

  async createRole(name: string): Promise<string> {
    await this.ready();
    const existing = await this.findRoleId(name);
    if (existing) return existing;
    const id = randomUUID();
    await this.run(this.insertIgnore(this.t.roles, ['id', 'name', 'created_at'], '?, ?, ?'), [
      id,
      name,
      new Date(),
    ]);
    return (await this.findRoleId(name)) ?? id;
  }

  async createPermission(name: string): Promise<string> {
    await this.ready();
    const existing = await this.findPermissionId(name);
    if (existing) return existing;
    const id = randomUUID();
    await this.run(this.insertIgnore(this.t.permissions, ['id', 'name', 'created_at'], '?, ?, ?'), [
      id,
      name,
      new Date(),
    ]);
    return (await this.findPermissionId(name)) ?? id;
  }

  async givePermissionToRole(roleName: string, permissionName: string): Promise<void> {
    const roleId = await this.createRole(roleName);
    const permissionId = await this.createPermission(permissionName);
    await this.run(this.insertIgnore(this.t.rolePermission, ['role_id', 'permission_id'], '?, ?'), [
      roleId,
      permissionId,
    ]);
  }

  async revokePermissionFromRole(roleName: string, permissionName: string): Promise<void> {
    await this.ready();
    const roleId = await this.findRoleId(roleName);
    const permissionId = await this.findPermissionId(permissionName);
    if (!roleId || !permissionId) return;
    await this.run(`DELETE FROM ${this.t.rolePermission} WHERE role_id = ? AND permission_id = ?`, [
      roleId,
      permissionId,
    ]);
  }

  async assignRole(user: UserRef, roleName: string, scope?: TenantScope): Promise<void> {
    const roleId = await this.createRole(roleName);
    const tenantId = normalizeTenant(scope);
    await this.run(
      this.insertIgnore(
        this.t.userRole,
        ['user_type', 'user_id', 'role_id', 'tenant_id'],
        '?, ?, ?, ?',
      ),
      [user.type, user.id, roleId, tenantId],
    );
  }

  async removeRole(user: UserRef, roleName: string, scope?: TenantScope): Promise<void> {
    await this.ready();
    const roleId = await this.findRoleId(roleName);
    if (!roleId) return;
    const tenantId = normalizeTenant(scope);
    await this.run(
      `DELETE FROM ${this.t.userRole} WHERE user_type = ? AND user_id = ? AND role_id = ? AND tenant_id = ?`,
      [user.type, user.id, roleId, tenantId],
    );
  }

  async giveUserPermission(user: UserRef, permissionName: string): Promise<void> {
    const permissionId = await this.createPermission(permissionName);
    await this.run(
      this.insertIgnore(
        this.t.userPermission,
        ['user_type', 'user_id', 'permission_id'],
        '?, ?, ?',
      ),
      [user.type, user.id, permissionId],
    );
  }

  async revokeUserPermission(user: UserRef, permissionName: string): Promise<void> {
    await this.ready();
    const permissionId = await this.findPermissionId(permissionName);
    if (!permissionId) return;
    await this.run(
      `DELETE FROM ${this.t.userPermission} WHERE user_type = ? AND user_id = ? AND permission_id = ?`,
      [user.type, user.id, permissionId],
    );
  }

  /**
   * Tenant filter SQL + bindings. Global request (`''`) → only global rows. A
   * tenant request → global OR that tenant's rows.
   */
  private tenantClause(scope: TenantScope | undefined): { sql: string; bindings: unknown[] } {
    const requested = normalizeTenant(scope);
    if (requested === GLOBAL_TENANT) {
      return { sql: 'ur.tenant_id = ?', bindings: [GLOBAL_TENANT] };
    }
    return { sql: '(ur.tenant_id = ? OR ur.tenant_id = ?)', bindings: [GLOBAL_TENANT, requested] };
  }

  async getRolesForUser(user: UserRef, scope?: TenantScope): Promise<string[]> {
    await this.ready();
    const tenant = this.tenantClause(scope);
    const rows = await this.query(
      `SELECT DISTINCT r.name AS name
       FROM ${this.t.userRole} ur
       JOIN ${this.t.roles} r ON r.id = ur.role_id
       WHERE ur.user_type = ? AND ur.user_id = ? AND ${tenant.sql}`,
      [user.type, user.id, ...tenant.bindings],
    );
    return rows.map((r) => r.name as string);
  }

  async getUsersForRole(role: string, scope?: TenantScope): Promise<UserRef[]> {
    await this.ready();
    const tenant = this.tenantClause(scope);
    const rows = await this.query(
      `SELECT DISTINCT ur.user_type AS user_type, ur.user_id AS user_id
       FROM ${this.t.userRole} ur
       JOIN ${this.t.roles} r ON r.id = ur.role_id
       WHERE r.name = ? AND ${tenant.sql}`,
      [role, ...tenant.bindings],
    );
    return rows.map((r) => ({ type: r.user_type as string, id: String(r.user_id) }));
  }

  async getPermissionsForUser(user: UserRef, scope?: TenantScope): Promise<string[]> {
    await this.ready();
    const tenant = this.tenantClause(scope);
    const result = new Set<string>();

    const roleDerived = await this.query(
      `SELECT DISTINCT p.name AS name
       FROM ${this.t.userRole} ur
       JOIN ${this.t.rolePermission} rp ON rp.role_id = ur.role_id
       JOIN ${this.t.permissions} p ON p.id = rp.permission_id
       WHERE ur.user_type = ? AND ur.user_id = ? AND ${tenant.sql}`,
      [user.type, user.id, ...tenant.bindings],
    );
    for (const row of roleDerived) result.add(row.name as string);

    const direct = await this.query(
      `SELECT p.name AS name
       FROM ${this.t.userPermission} up
       JOIN ${this.t.permissions} p ON p.id = up.permission_id
       WHERE up.user_type = ? AND up.user_id = ?`,
      [user.type, user.id],
    );
    for (const row of direct) result.add(row.name as string);

    return [...result];
  }

  async userHasPermission(
    user: UserRef,
    permission: string,
    scope?: TenantScope,
  ): Promise<boolean> {
    await this.ready();
    const tenant = this.tenantClause(scope);
    const roleHit = await this.query(
      `SELECT 1 AS hit
       FROM ${this.t.userRole} ur
       JOIN ${this.t.rolePermission} rp ON rp.role_id = ur.role_id
       JOIN ${this.t.permissions} p ON p.id = rp.permission_id
       WHERE ur.user_type = ? AND ur.user_id = ? AND p.name = ? AND ${tenant.sql}
       LIMIT 1`,
      [user.type, user.id, permission, ...tenant.bindings],
    );
    if (roleHit.length > 0) return true;

    const directHit = await this.query(
      `SELECT 1 AS hit
       FROM ${this.t.userPermission} up
       JOIN ${this.t.permissions} p ON p.id = up.permission_id
       WHERE up.user_type = ? AND up.user_id = ? AND p.name = ?
       LIMIT 1`,
      [user.type, user.id, permission],
    );
    return directHit.length > 0;
  }

  async listRoles(): Promise<string[]> {
    await this.ready();
    const rows = await this.query(`SELECT name FROM ${this.t.roles} ORDER BY name`);
    return rows.map((r) => r.name as string);
  }

  async listPermissions(): Promise<string[]> {
    await this.ready();
    const rows = await this.query(`SELECT name FROM ${this.t.permissions} ORDER BY name`);
    return rows.map((r) => r.name as string);
  }

  async getRolePermissions(roleName: string): Promise<string[]> {
    await this.ready();
    const roleId = await this.findRoleId(roleName);
    if (!roleId) return [];
    const rows = await this.query(
      `SELECT p.name AS name
       FROM ${this.t.rolePermission} rp
       JOIN ${this.t.permissions} p ON p.id = rp.permission_id
       WHERE rp.role_id = ?
       ORDER BY p.name`,
      [roleId],
    );
    return rows.map((r) => r.name as string);
  }
}
