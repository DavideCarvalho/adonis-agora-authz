import { describe, expect, it } from 'vitest';
import type { PermissionStore } from './store.js';
import type { SubjectRef } from './subject_ref.js';

/** Factory producing a FRESH, isolated store for each test. */
export type StoreFactory = () => PermissionStore | Promise<PermissionStore>;

const alice: SubjectRef = { type: 'user', id: '1' };
const bob: SubjectRef = { type: 'user', id: '2' };

/**
 * The shared {@link PermissionStore} contract suite. Each store driver re-runs
 * it (see the memory and Lucid `*.contract.spec.ts`). Exposed on the public
 * `@adonis-agora/authz/testing` subpath so downstream stores can self-validate.
 */
export function runPermissionStoreContract(name: string, factory: StoreFactory): void {
  describe(`PermissionStore contract: ${name}`, () => {
    it('creates roles and permissions idempotently', async () => {
      const store = await factory();
      const r1 = await store.createRole('admin');
      const r2 = await store.createRole('admin');
      expect(r1).toBe(r2);
      const p1 = await store.createPermission('posts.edit');
      const p2 = await store.createPermission('posts.edit');
      expect(p1).toBe(p2);
      expect(await store.listRoles()).toContain('admin');
      expect(await store.listPermissions()).toContain('posts.edit');
    });

    it('grants permissions to a role and resolves them for assigned users', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.assignRole(alice, 'editor');
      expect(await store.getRolesForSubject(alice)).toContain('editor');
      expect(await store.getPermissionsForSubject(alice)).toContain('posts.edit');
      expect(await store.subjectHasPermission(alice, 'posts.edit')).toBe(true);
      expect(await store.subjectHasPermission(bob, 'posts.edit')).toBe(false);
    });

    it('revokes a permission from a role', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.assignRole(alice, 'editor');
      await store.revokePermissionFromRole('editor', 'posts.edit');
      expect(await store.subjectHasPermission(alice, 'posts.edit')).toBe(false);
    });

    it('removes a role from a user', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.assignRole(alice, 'editor');
      await store.removeRole(alice, 'editor');
      expect(await store.getRolesForSubject(alice)).not.toContain('editor');
      expect(await store.subjectHasPermission(alice, 'posts.edit')).toBe(false);
    });

    it('supports direct user permission grants (tenant-independent)', async () => {
      const store = await factory();
      await store.giveSubjectPermission(alice, 'billing.view');
      expect(await store.subjectHasPermission(alice, 'billing.view')).toBe(true);
      // Direct grants apply regardless of tenant.
      expect(await store.subjectHasPermission(alice, 'billing.view', { tenantId: 't1' })).toBe(
        true,
      );
      await store.revokeSubjectPermission(alice, 'billing.view');
      expect(await store.subjectHasPermission(alice, 'billing.view')).toBe(false);
    });

    it('keeps a role-derived permission after revoking only the direct grant', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.assignRole(alice, 'editor');
      await store.giveSubjectPermission(alice, 'posts.edit');
      await store.revokeSubjectPermission(alice, 'posts.edit');
      // Still granted via the role.
      expect(await store.subjectHasPermission(alice, 'posts.edit')).toBe(true);
    });

    it('isolates assignments per user', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.assignRole(alice, 'editor');
      expect(await store.getPermissionsForSubject(bob)).toHaveLength(0);
    });

    it('honors tenant visibility', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.givePermissionToRole('viewer', 'posts.view');
      // Global assignment.
      await store.assignRole(alice, 'editor');
      // Tenant-scoped assignment.
      await store.assignRole(alice, 'viewer', { tenantId: 't1' });

      // Global request: only global rows.
      expect(await store.getRolesForSubject(alice)).toEqual(['editor']);
      expect(await store.subjectHasPermission(alice, 'posts.view')).toBe(false);

      // Tenant request: global + that tenant.
      const tenantRoles = await store.getRolesForSubject(alice, { tenantId: 't1' });
      expect(tenantRoles).toEqual(expect.arrayContaining(['editor', 'viewer']));
      expect(await store.subjectHasPermission(alice, 'posts.view', { tenantId: 't1' })).toBe(true);
      // A different tenant does not see t1's grant.
      expect(await store.subjectHasPermission(alice, 'posts.view', { tenantId: 't2' })).toBe(false);
    });

    it('respects the polymorphic user type', async () => {
      const store = await factory();
      const adminUser: SubjectRef = { type: 'admin', id: '1' };
      await store.givePermissionToRole('superuser', 'system.manage');
      await store.assignRole(adminUser, 'superuser');
      // Same id, different type → no grant.
      expect(await store.subjectHasPermission({ type: 'user', id: '1' }, 'system.manage')).toBe(
        false,
      );
      expect(await store.subjectHasPermission(adminUser, 'system.manage')).toBe(true);
    });

    it('lists permissions attached to a role', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.givePermissionToRole('editor', 'posts.delete');
      const perms = await store.getRolePermissions('editor');
      expect(perms).toEqual(expect.arrayContaining(['posts.edit', 'posts.delete']));
    });

    it('reverse-resolves the users holding a role (getSubjectsForRole)', async () => {
      const store = await factory();
      await store.createRole('editor');
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor');
      // A user with a DIFFERENT role must not appear.
      const carol: SubjectRef = { type: 'user', id: '3' };
      await store.assignRole(carol, 'viewer');

      const editors = await store.getSubjectsForRole('editor');
      expect(editors).toEqual(
        expect.arrayContaining([
          { type: 'user', id: '1' },
          { type: 'user', id: '2' },
        ]),
      );
      expect(editors).toHaveLength(2);
      expect(editors).not.toContainEqual({ type: 'user', id: '3' });
      // Unknown role → empty.
      expect(await store.getSubjectsForRole('nobody')).toEqual([]);
    });

    it('reverse-resolves preserving the polymorphic user type', async () => {
      const store = await factory();
      const adminUser: SubjectRef = { type: 'admin', id: '1' };
      await store.assignRole(adminUser, 'superuser');
      await store.assignRole({ type: 'user', id: '1' }, 'superuser');
      const users = await store.getSubjectsForRole('superuser');
      expect(users).toContainEqual({ type: 'admin', id: '1' });
      expect(users).toContainEqual({ type: 'user', id: '1' });
      expect(users).toHaveLength(2);
    });

    it('reverse-resolves with tenant visibility (getSubjectsForRole)', async () => {
      const store = await factory();
      // Global assignment for alice; tenant t1 assignment for bob.
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor', { tenantId: 't1' });

      // Global request: only the global assignee.
      const global = await store.getSubjectsForRole('editor');
      expect(global).toEqual([{ type: 'user', id: '1' }]);

      // t1 request: global + t1's own.
      const t1 = await store.getSubjectsForRole('editor', { tenantId: 't1' });
      expect(t1).toEqual(
        expect.arrayContaining([
          { type: 'user', id: '1' },
          { type: 'user', id: '2' },
        ]),
      );
      expect(t1).toHaveLength(2);

      // A different tenant must NOT see t1's assignee.
      const t2 = await store.getSubjectsForRole('editor', { tenantId: 't2' });
      expect(t2).toEqual([{ type: 'user', id: '1' }]);
      expect(t2).not.toContainEqual({ type: 'user', id: '2' });
    });

    it('counts the users holding a role (countSubjectsForRole)', async () => {
      const store = await factory();
      expect(await store.countSubjectsForRole('editor')).toBe(0);
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor');
      // Same user twice → one distinct member.
      await store.assignRole(alice, 'editor');
      expect(await store.countSubjectsForRole('editor')).toBe(2);
      // Unknown role → 0, not an error.
      expect(await store.countSubjectsForRole('nobody')).toBe(0);
    });

    it('counts members with the same tenant visibility as getSubjectsForRole', async () => {
      const store = await factory();
      // Global assignment for alice; tenant t1 assignment for bob.
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor', { tenantId: 't1' });

      expect(await store.countSubjectsForRole('editor')).toBe(1);
      expect(await store.countSubjectsForRole('editor', { tenantId: 't1' })).toBe(2);
      expect(await store.countSubjectsForRole('editor', { tenantId: 't2' })).toBe(1);
    });

    it('counts distinct SUBJECTS: two types sharing an id are two members', async () => {
      // The polymorphic key is (type, id). A count that forgets the type
      // undercounts exactly the setup this library targets — and drifts from
      // getSubjectsForRole, which never forgets it. This case keeps the stores
      // honest: it must equal getSubjectsForRole(...).length in both.
      const store = await factory();
      await store.assignRole(alice, 'superuser');
      await store.assignRole({ type: 'admin', id: '1' }, 'superuser');
      expect(await store.countSubjectsForRole('superuser')).toBe(2);
      expect(await store.countSubjectsForRole('superuser')).toBe(
        (await store.getSubjectsForRole('superuser')).length,
      );
      const counts = await store.countSubjectsByRole();
      expect(counts.superuser).toBe(2);
    });

    it('counts members per role in one pass, empty roles included (countSubjectsByRole)', async () => {
      const store = await factory();
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor');
      await store.assignRole({ type: 'admin', id: '1' }, 'superuser');
      await store.createRole('abandoned');

      const counts = await store.countSubjectsByRole();
      expect(counts.editor).toBe(2);
      expect(counts.superuser).toBe(1);
      // A role nobody holds still shows up — a matrix row with 0, not a missing key.
      expect(counts.abandoned).toBe(0);
    });

    it('honors tenant scope in countSubjectsByRole', async () => {
      const store = await factory();
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor', { tenantId: 't1' });

      const global = await store.countSubjectsByRole();
      expect(global.editor).toBe(1);
      const t1 = await store.countSubjectsByRole({ tenantId: 't1' });
      expect(t1.editor).toBe(2);
      const t2 = await store.countSubjectsByRole({ tenantId: 't2' });
      expect(t2.editor).toBe(1);
    });

    it('deletes a role and everything hanging off it (deleteRole)', async () => {
      const store = await factory();
      await store.givePermissionToRole('editor', 'posts.edit');
      await store.assignRole(alice, 'editor');
      await store.assignRole(bob, 'editor', { tenantId: 't1' });

      await store.deleteRole('editor');

      expect(await store.listRoles()).not.toContain('editor');
      expect(await store.getRolesForSubject(alice)).not.toContain('editor');
      expect(await store.getRolesForSubject(alice, { tenantId: 't1' })).not.toContain('editor');
      expect(await store.getSubjectsForRole('editor')).toEqual([]);
      expect(await store.getRolePermissions('editor')).toEqual([]);
      expect(await store.subjectHasPermission(alice, 'posts.edit')).toBe(false);
      // Another role's grants survive.
      await store.givePermissionToRole('viewer', 'posts.view');
      await store.assignRole(alice, 'viewer');
      await store.deleteRole('editor');
      expect(await store.subjectHasPermission(alice, 'posts.view')).toBe(true);
    });

    it('deleteRole is idempotent on an unknown role', async () => {
      const store = await factory();
      await expect(store.deleteRole('ghost')).resolves.toBeUndefined();
    });
  });
}
