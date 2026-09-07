import { afterEach, describe, expect, it } from 'vitest';
import { AGORA_CONTEXT_ACCESSOR, tenantFromContext } from './agora/context.js';
import { AuthzService } from './authz_service.js';
import { MemoryPermissionStore } from './stores/memory.js';

type GlobalSlots = Record<symbol, unknown>;

function setContext(value: unknown): void {
  (globalThis as GlobalSlots)[AGORA_CONTEXT_ACCESSOR] = value;
}

afterEach(() => {
  delete (globalThis as GlobalSlots)[AGORA_CONTEXT_ACCESSOR];
});

const user = { id: '1', type: 'user' };

describe('feature B — tenant auto-scope', () => {
  it('default (no resolveTenant) ignores context tenant — behavior unchanged', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('viewer', 'reports.view');
    await store.assignRole({ type: 'user', id: '1' }, 'viewer', { tenantId: 'acme' });
    const service = new AuthzService({ store });

    // The real @adonis-agora/context accessor publishes `tenantId` as a METHOD, not a
    // plain property — mock it that way so this test exercises the real contract.
    setContext({ tenantId: () => 'acme' });
    // Without opt-in, the check is global '' → tenant-scoped grant invisible.
    expect(await service.can(user, 'reports.view')).toBe(false);
  });

  it('resolveTenant: tenantFromContext defaults the tenant to the context tenantId', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('viewer', 'reports.view');
    await store.assignRole({ type: 'user', id: '1' }, 'viewer', { tenantId: 'acme' });
    const service = new AuthzService({ store, resolveTenant: tenantFromContext });

    setContext({ tenantId: () => 'acme' });
    expect(await service.can(user, 'reports.view')).toBe(true);

    setContext({ tenantId: () => 'other' });
    expect(await service.can(user, 'reports.view')).toBe(false);
  });

  it('explicit scope wins over the context', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('viewer', 'reports.view');
    await store.assignRole({ type: 'user', id: '1' }, 'viewer', { tenantId: 'acme' });
    const service = new AuthzService({ store, resolveTenant: tenantFromContext });

    setContext({ tenantId: () => 'other' });
    expect(await service.can(user, 'reports.view', { scope: { tenantId: 'acme' } })).toBe(true);
  });

  it('accepts a custom resolveTenant function', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('viewer', 'reports.view');
    await store.assignRole({ type: 'user', id: '1' }, 'viewer', { tenantId: 't9' });
    const service = new AuthzService({ store, resolveTenant: () => 't9' });
    expect(await service.can(user, 'reports.view')).toBe(true);
  });
});

describe('feature C — global-role bridge', () => {
  it('super-admin global role short-circuits allow consistently across can/hasRole/hasAnyRole', async () => {
    const store = new MemoryPermissionStore();
    const service = new AuthzService({ store, superAdminRoles: ['platform:super'] });

    setContext({ get: () => ({ globalRoles: ['platform:super'] }) });
    expect(await service.can(user, 'anything.at.all')).toBe(true);
    expect(await service.hasRole(user, 'whatever')).toBe(true);
    // Regression: a global super-admin must agree across hasRole and hasAnyRole.
    expect(await service.hasAnyRole(user, ['whatever'])).toBe(true);
    expect(await service.hasAnyRole(user, ['a', 'b'])).toBe(true);
  });

  it('roleGrants map is permission-only: the granted permission string is never a role', async () => {
    const store = new MemoryPermissionStore();
    const service = new AuthzService({
      store,
      roleGrants: { auditor: ['audit.*'] },
    });

    setContext({ get: () => ({ globalRoles: ['auditor'] }) });
    // Permission union sees the global grant...
    expect(await service.can(user, 'audit.read')).toBe(true);
    // ...and the context role itself IS a real effective role (hasRole reflects it directly,
    // independent of roleGrants — see resolve-roles.spec.ts).
    expect(await service.hasRole(user, 'auditor')).toBe(true);
    // ...but the granted PERMISSION string is never treated as a role name.
    expect(await service.hasRole(user, 'audit.*')).toBe(false);
    // hasAnyRole checks the SAME effective-role union as hasRole (context ∪ resolveRoles ∪
    // store), so it recognizes the context role 'auditor' — but 'audit.read' is a permission,
    // never a role, so it contributes nothing here.
    expect(await service.hasAnyRole(user, ['auditor', 'audit.read'])).toBe(true);
    expect(await service.hasAnyRole(user, ['audit.read'])).toBe(false);
  });

  it('roleGrants are unioned into the permission check', async () => {
    const store = new MemoryPermissionStore();
    const service = new AuthzService({
      store,
      roleGrants: { auditor: ['audit.*'] },
    });

    setContext({ get: () => ({ globalRoles: ['auditor'] }) });
    expect(await service.can(user, 'audit.read')).toBe(true);
    expect(await service.can(user, 'posts.edit')).toBe(false);
  });

  it('default (no config) ignores context global roles for permission grants — behavior unchanged', async () => {
    const store = new MemoryPermissionStore();
    const service = new AuthzService({ store });
    setContext({ get: () => ({ globalRoles: ['platform:super'] }) });
    expect(await service.can(user, 'anything')).toBe(false);
  });

  it('no context → falls through to normal RBAC', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    const service = new AuthzService({
      store,
      superAdminRoles: ['platform:super'],
      roleGrants: { auditor: ['audit.*'] },
    });
    expect(await service.can(user, 'posts.edit')).toBe(true);
    expect(await service.can(user, 'audit.read')).toBe(false);
  });
});
