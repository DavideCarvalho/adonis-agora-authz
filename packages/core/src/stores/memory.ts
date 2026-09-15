import { randomUUID } from 'node:crypto';
import type { PermissionStore } from '../store.js';
import {
  GLOBAL_TENANT,
  normalizeTenant,
  type SubjectRef,
  type TenantScope,
} from '../subject_ref.js';

interface SubjectRoleRow {
  subjectType: string;
  subjectId: string;
  roleId: string;
  tenantId: string;
}

interface SubjectPermissionRow {
  subjectType: string;
  subjectId: string;
  permissionId: string;
}

/**
 * Collision-free composite key over host-controlled strings. The separator may
 * not be a visible character (types and ids can contain spaces, colons, ...)
 * and may not be a raw NUL (embedded NULs make this file unreadable to git
 * diff). JSON.stringify the tuple: distinct tuples always yield distinct keys.
 */
const compositeKey = (...parts: string[]): string => JSON.stringify(parts);

const subjectKey = (u: SubjectRef): string => compositeKey(u.type, u.id);

/**
 * Zero-peer, in-process {@link PermissionStore}. Faithful to the Lucid store's
 * semantics (idempotency, tenant visibility, direct-grant rules) so the same
 * contract suite passes against both. Intended for tests and tiny apps.
 */
export class MemoryPermissionStore implements PermissionStore {
  private roles = new Map<string, string>(); // name -> id
  private permissions = new Map<string, string>(); // name -> id
  private rolePermissions = new Set<string>(); // compositeKey(roleId, permissionId)
  private subjectRoles: SubjectRoleRow[] = [];
  private subjectPermissions: SubjectPermissionRow[] = [];

  async ensureSchema(): Promise<void> {
    // Nothing to do — purely in-memory.
  }

  async createRole(name: string): Promise<string> {
    const existing = this.roles.get(name);
    if (existing) return existing;
    const id = randomUUID();
    this.roles.set(name, id);
    return id;
  }

  async createPermission(name: string): Promise<string> {
    const existing = this.permissions.get(name);
    if (existing) return existing;
    const id = randomUUID();
    this.permissions.set(name, id);
    return id;
  }

  async givePermissionToRole(roleName: string, permissionName: string): Promise<void> {
    const roleId = await this.createRole(roleName);
    const permissionId = await this.createPermission(permissionName);
    this.rolePermissions.add(compositeKey(roleId, permissionId));
  }

  async revokePermissionFromRole(roleName: string, permissionName: string): Promise<void> {
    const roleId = this.roles.get(roleName);
    const permissionId = this.permissions.get(permissionName);
    if (!roleId || !permissionId) return;
    this.rolePermissions.delete(compositeKey(roleId, permissionId));
  }

  async assignRole(user: SubjectRef, roleName: string, scope?: TenantScope): Promise<void> {
    const roleId = await this.createRole(roleName);
    const tenantId = normalizeTenant(scope);
    const exists = this.subjectRoles.some(
      (r) =>
        r.subjectType === user.type &&
        r.subjectId === user.id &&
        r.roleId === roleId &&
        r.tenantId === tenantId,
    );
    if (!exists) {
      this.subjectRoles.push({ subjectType: user.type, subjectId: user.id, roleId, tenantId });
    }
  }

  async removeRole(user: SubjectRef, roleName: string, scope?: TenantScope): Promise<void> {
    const roleId = this.roles.get(roleName);
    if (!roleId) return;
    const tenantId = normalizeTenant(scope);
    this.subjectRoles = this.subjectRoles.filter(
      (r) =>
        !(
          r.subjectType === user.type &&
          r.subjectId === user.id &&
          r.roleId === roleId &&
          r.tenantId === tenantId
        ),
    );
  }

  /** Idempotent like the Lucid store: unknown name is a no-op; members' rows and the role go together. */
  async deleteRole(name: string): Promise<void> {
    const roleId = this.roles.get(name);
    if (!roleId) return;
    this.roles.delete(name);
    this.subjectRoles = this.subjectRoles.filter((r) => r.roleId !== roleId);
    for (const rp of [...this.rolePermissions]) {
      if ((JSON.parse(rp) as string[])[0] === roleId) this.rolePermissions.delete(rp);
    }
  }

  async giveSubjectPermission(user: SubjectRef, permissionName: string): Promise<void> {
    const permissionId = await this.createPermission(permissionName);
    const exists = this.subjectPermissions.some(
      (r) =>
        r.subjectType === user.type && r.subjectId === user.id && r.permissionId === permissionId,
    );
    if (!exists) {
      this.subjectPermissions.push({ subjectType: user.type, subjectId: user.id, permissionId });
    }
  }

  async revokeSubjectPermission(user: SubjectRef, permissionName: string): Promise<void> {
    const permissionId = this.permissions.get(permissionName);
    if (!permissionId) return;
    this.subjectPermissions = this.subjectPermissions.filter(
      (r) =>
        !(
          r.subjectType === user.type &&
          r.subjectId === user.id &&
          r.permissionId === permissionId
        ),
    );
  }

  /** Tenant rows visible for a request: global always, plus the tenant's own. */
  private tenantVisible(rowTenant: string, requested: string): boolean {
    if (requested === GLOBAL_TENANT) return rowTenant === GLOBAL_TENANT;
    return rowTenant === GLOBAL_TENANT || rowTenant === requested;
  }

  private roleIdToName(id: string): string | undefined {
    for (const [name, roleId] of this.roles) if (roleId === id) return name;
    return undefined;
  }

  private permissionIdToName(id: string): string | undefined {
    for (const [name, permId] of this.permissions) if (permId === id) return name;
    return undefined;
  }

  async getRolesForSubject(user: SubjectRef, scope?: TenantScope): Promise<string[]> {
    const requested = normalizeTenant(scope);
    const out = new Set<string>();
    for (const r of this.subjectRoles) {
      if (r.subjectType !== user.type || r.subjectId !== user.id) continue;
      if (!this.tenantVisible(r.tenantId, requested)) continue;
      const name = this.roleIdToName(r.roleId);
      if (name) out.add(name);
    }
    return [...out];
  }

  async getSubjectsForRole(role: string, scope?: TenantScope): Promise<SubjectRef[]> {
    const roleId = this.roles.get(role);
    if (!roleId) return [];
    const requested = normalizeTenant(scope);
    const seen = new Set<string>();
    const out: SubjectRef[] = [];
    for (const r of this.subjectRoles) {
      if (r.roleId !== roleId) continue;
      if (!this.tenantVisible(r.tenantId, requested)) continue;
      const key = subjectKey({ type: r.subjectType, id: r.subjectId });
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: r.subjectType, id: r.subjectId });
    }
    return out;
  }

  async countSubjectsForRole(role: string, scope?: TenantScope): Promise<number> {
    return (await this.getSubjectsForRole(role, scope)).length;
  }

  async countSubjectsByRole(scope?: TenantScope): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const name of this.roles.keys()) {
      counts[name] = (await this.getSubjectsForRole(name, scope)).length;
    }
    return counts;
  }

  async getPermissionsForSubject(user: SubjectRef, scope?: TenantScope): Promise<string[]> {
    const out = new Set<string>();

    // Role-derived (tenant-aware).
    const roleIds = new Set<string>();
    const requested = normalizeTenant(scope);
    for (const r of this.subjectRoles) {
      if (r.subjectType !== user.type || r.subjectId !== user.id) continue;
      if (!this.tenantVisible(r.tenantId, requested)) continue;
      roleIds.add(r.roleId);
    }
    for (const rp of this.rolePermissions) {
      const [roleId, permissionId] = JSON.parse(rp) as string[];
      if (roleId && permissionId && roleIds.has(roleId)) {
        const name = this.permissionIdToName(permissionId);
        if (name) out.add(name);
      }
    }

    // Direct grants (tenant-independent).
    for (const up of this.subjectPermissions) {
      if (up.subjectType !== user.type || up.subjectId !== user.id) continue;
      const name = this.permissionIdToName(up.permissionId);
      if (name) out.add(name);
    }

    return [...out];
  }

  async subjectHasPermission(
    user: SubjectRef,
    permission: string,
    scope?: TenantScope,
  ): Promise<boolean> {
    const all = await this.getPermissionsForSubject(user, scope);
    return all.includes(permission);
  }

  async listRoles(): Promise<string[]> {
    return [...this.roles.keys()];
  }

  async listPermissions(): Promise<string[]> {
    return [...this.permissions.keys()];
  }

  async getRolePermissions(roleName: string): Promise<string[]> {
    const roleId = this.roles.get(roleName);
    if (!roleId) return [];
    const out: string[] = [];
    for (const rp of this.rolePermissions) {
      const [rId, permissionId] = JSON.parse(rp) as string[];
      if (rId === roleId && permissionId) {
        const name = this.permissionIdToName(permissionId);
        if (name) out.push(name);
      }
    }
    return out;
  }

  /** No client to join: the in-memory store has no connection to scope to. */
  withClient(): MemoryPermissionStore {
    return this;
  }
}
