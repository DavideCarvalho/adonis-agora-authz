import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGORA_CONTEXT_ACCESSOR } from '../src/agora/context.js';
import { AGORA_CONTEXT_TENANCY, type TenantFilter } from '../src/agora/tenancy.js';
import { AuthzService, type AuthzServiceOptions } from '../src/authz_service.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

const makeSpy = vi.fn();
vi.mock('@adonisjs/core/services/app', () => ({
  default: { container: { make: (key: unknown) => makeSpy(key) } },
}));

type Slots = Record<symbol, unknown>;

interface Level {
  id: string;
  kind: string;
  role?: string;
}

/**
 * Publish a fake context: caller `userId`, tenancy `enabled`, and the active tenant `chain`
 * (outermost first). Mirrors `@adonis-agora/context`'s `tenantFilter` for `kinds`.
 */
function context(opts: {
  userId?: string;
  enabled?: boolean;
  kinds?: string[];
  chain?: Level[];
  mode?: 'all' | 'system';
  globalRoles?: string[];
}) {
  const store = {
    ...(opts.userId ? { userRef: { type: 'user', id: opts.userId } } : {}),
    globalRoles: opts.globalRoles ?? [],
  };
  (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR] = { get: () => store };
  (globalThis as Slots)[AGORA_CONTEXT_TENANCY] = {
    version: 1,
    tenancy: () => ({ enabled: opts.enabled ?? true, kinds: opts.kinds }),
    tenantFilter: (options?: { kinds?: string[] }): TenantFilter => {
      if (opts.mode) return { mode: opts.mode };
      const chain = opts.chain ?? [];
      const kinds = options?.kinds ?? opts.kinds;
      for (let i = chain.length - 1; i >= 0; i--) {
        const level = chain[i] as Level;
        if (kinds && !kinds.includes(level.kind)) continue;
        const cut = chain.slice(0, i + 1);
        return { mode: 'tenant', tenant: { ...level, source: 'authkit' }, chain: cut };
      }
      return { mode: 'tenantless' };
    },
  };
}

afterEach(() => {
  delete (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR];
  delete (globalThis as Slots)[AGORA_CONTEXT_TENANCY];
  makeSpy.mockReset();
});

async function setup(options: Partial<AuthzServiceOptions> = {}) {
  const store = new MemoryPermissionStore();
  await store.assignRole({ type: 'user', id: 'ana' }, 'editor', { tenantId: 'acme' });
  await store.givePermissionToRole('editor', 'posts.edit');
  const authz = new AuthzService({
    store,
    roleGrants: { org_admin: ['billing.manage'], org_member: ['posts.read'] },
    ...options,
  });
  return { store, authz };
}

describe('organization as tenant', () => {
  it('uses the context tenant as the default scope when tenancy is on', async () => {
    const { authz } = await setup();
    context({ userId: 'ana', chain: [{ id: 'acme', kind: 'organization' }] });
    expect(authz.currentScope()).toEqual({ tenantId: 'acme' });
    expect(await authz.can({ id: 'ana' }, 'posts.edit')).toBe(true);

    context({ userId: 'ana', chain: [{ id: 'globex', kind: 'organization' }] });
    expect(await authz.can({ id: 'ana' }, 'posts.edit')).toBe(false);
  });

  it('changes nothing when context tenancy is off, the slot is missing, or tenancy is false', async () => {
    const { authz } = await setup();
    context({ userId: 'ana', enabled: false, chain: [{ id: 'acme', kind: 'organization' }] });
    expect(authz.currentScope()).toBeUndefined();
    expect(await authz.can({ id: 'ana' }, 'posts.edit')).toBe(false);

    delete (globalThis as Slots)[AGORA_CONTEXT_TENANCY];
    expect(authz.currentScope()).toBeUndefined();

    const { authz: optedOut } = await setup({ tenancy: false });
    context({ userId: 'ana', chain: [{ id: 'acme', kind: 'organization' }] });
    expect(optedOut.currentScope()).toBeUndefined();
  });

  it('an explicit scope, `tenant` or `resolveTenant` wins over the context tenant', async () => {
    context({ userId: 'ana', chain: [{ id: 'acme', kind: 'organization' }] });
    const { authz } = await setup();
    expect(authz.currentScope({ tenantId: 'other' })).toEqual({ tenantId: 'other' });
    const { authz: withResolver } = await setup({ tenant: () => 'fixed' });
    expect(withResolver.currentScope()).toEqual({ tenantId: 'fixed' });
    const { authz: withResolveTenant } = await setup({ resolveTenant: () => undefined });
    expect(withResolveTenant.currentScope()).toBeUndefined();
  });

  it('forces tenancy on or off regardless of context with `enabled`', async () => {
    context({ userId: 'ana', enabled: false, chain: [{ id: 'acme', kind: 'organization' }] });
    const { authz } = await setup({ tenancy: { enabled: true } });
    expect(authz.currentScope()).toEqual({ tenantId: 'acme' });
    expect(authz.tenancyEnabled()).toBe(true);
  });

  it('honours `kinds`, picking the innermost level of a listed kind in a chain', async () => {
    const chain = [
      { id: 'clinic-1', kind: 'clinic', role: 'owner' },
      { id: 'unit-9', kind: 'unit', role: 'member' },
    ];
    context({ userId: 'ana', chain });
    const { authz: unit } = await setup();
    expect(unit.currentScope()).toEqual({ tenantId: 'unit-9' });
    const { authz: clinic } = await setup({ tenancy: { kinds: ['clinic'] } });
    expect(clinic.currentScope()).toEqual({ tenantId: 'clinic-1' });
    const { authz: none } = await setup({ tenancy: { kinds: ['organization'] } });
    expect(none.currentScope()).toBeUndefined();
  });

  it('stays global inside allTenants() and outside a request', async () => {
    const { authz } = await setup();
    context({ userId: 'ana', mode: 'all' });
    expect(authz.currentScope()).toBeUndefined();
    context({ userId: 'ana', mode: 'system' });
    expect(authz.currentScope()).toBeUndefined();
  });

  it('never throws when context requires a tenant', async () => {
    const { authz } = await setup();
    context({ userId: 'ana' });
    (globalThis as Slots)[AGORA_CONTEXT_TENANCY] = {
      version: 1,
      tenancy: () => ({ enabled: true }),
      tenantFilter: (o?: { required?: boolean }) => {
        if (o?.required !== false) throw new Error('tenant required');
        return { mode: 'tenantless' };
      },
    };
    expect(authz.currentScope()).toBeUndefined();
  });

  describe('tenancy.roles', () => {
    const roles = { owner: 'org_admin', member: ['org_member'] };

    it("maps the caller's role in the active tenant to authz roles in that tenant only", async () => {
      const { authz } = await setup({ tenancy: { roles } });
      context({ userId: 'bob', chain: [{ id: 'acme', kind: 'organization', role: 'owner' }] });
      expect(await authz.effectiveRoles({ id: 'bob' })).toEqual(['org_admin']);
      expect(await authz.can({ id: 'bob' }, 'billing.manage')).toBe(true);
      expect(await authz.hasRole({ id: 'bob' }, 'org_admin')).toBe(true);
      // Not globally, not in another tenant.
      expect(await authz.effectiveRoles({ id: 'bob' }, { tenantId: '' })).toEqual([]);
      expect(
        await authz.can({ id: 'bob' }, 'billing.manage', { scope: { tenantId: 'globex' } }),
      ).toBe(false);
    });

    it('applies to the caller only, never to another subject asked about', async () => {
      const { authz } = await setup({ tenancy: { roles } });
      context({ userId: 'bob', chain: [{ id: 'acme', kind: 'organization', role: 'owner' }] });
      expect(await authz.effectiveRoles({ id: 'ana' })).toEqual(['editor']);
    });

    it('grants nothing for an unmapped role or without the option', async () => {
      context({ userId: 'bob', chain: [{ id: 'acme', kind: 'organization', role: 'guest' }] });
      const { authz } = await setup({ tenancy: { roles } });
      expect(await authz.effectiveRoles({ id: 'bob' })).toEqual([]);
      context({ userId: 'bob', chain: [{ id: 'acme', kind: 'organization', role: 'owner' }] });
      const { authz: plain } = await setup();
      expect(await plain.effectiveRoles({ id: 'bob' })).toEqual([]);
      context({ userId: 'bob', chain: [{ id: 'acme', kind: 'organization', role: 'toString' }] });
      expect(await authz.effectiveRoles({ id: 'bob' })).toEqual([]);
    });

    it('maps the role of a parent level when the check is scoped to it', async () => {
      const { authz } = await setup({ tenancy: { roles } });
      context({
        userId: 'bob',
        chain: [
          { id: 'clinic-1', kind: 'clinic', role: 'owner' },
          { id: 'unit-9', kind: 'unit', role: 'member' },
        ],
      });
      expect(await authz.effectiveRoles({ id: 'bob' })).toEqual(['org_member']);
      expect(await authz.effectiveRoles({ id: 'bob' }, { tenantId: 'clinic-1' })).toEqual([
        'org_admin',
      ]);
    });

    it('is off while tenancy is off', async () => {
      const { authz } = await setup({ tenancy: { roles } });
      context({
        userId: 'bob',
        enabled: false,
        chain: [{ id: 'acme', kind: 'organization', role: 'owner' }],
      });
      expect(await authz.effectiveRoles({ id: 'bob' }, { tenantId: 'acme' })).toEqual([]);
    });
  });

  describe('authorizeByRoles({ allTenants })', () => {
    it('returns tenants: "*" for a global allTenants role, plain allow otherwise', async () => {
      const { authorizeByRoles } = await import('../src/authorize.js');
      const { store, authz } = await setup({ tenancy: { roles: { owner: 'org_admin' } } });
      await store.assignRole({ type: 'user', id: 'root' }, 'ADMIN');
      makeSpy.mockResolvedValue(authz);
      const gate = authorizeByRoles({ roles: ['ADMIN', 'org_admin'], allTenants: ['ADMIN'] });

      context({ userId: 'root', chain: [{ id: 'acme', kind: 'organization' }] });
      expect(await gate({ auth: { user: { id: 'root' } } })).toEqual({
        allowed: true,
        tenants: '*',
      });

      context({ userId: 'bob', chain: [{ id: 'acme', kind: 'organization', role: 'owner' }] });
      expect(await gate({ auth: { user: { id: 'bob' } } })).toBe(true);
    });

    it('an allTenants role held only inside one tenant does not widen to all tenants', async () => {
      const { authorizeByRoles } = await import('../src/authorize.js');
      const { store, authz } = await setup();
      await store.assignRole({ type: 'user', id: 'carol' }, 'ADMIN', { tenantId: 'acme' });
      makeSpy.mockResolvedValue(authz);
      context({ userId: 'carol', chain: [{ id: 'acme', kind: 'organization' }] });
      const gate = authorizeByRoles({ roles: ['ADMIN'], allTenants: ['ADMIN'] });
      expect(await gate({ auth: { user: { id: 'carol' } } })).toBe(true);
    });

    it('a superAdminRoles role sees every tenant', async () => {
      const { authorizeByRoles } = await import('../src/authorize.js');
      const { authz } = await setup({ superAdminRoles: ['ROOT'] });
      makeSpy.mockResolvedValue(authz);
      context({ userId: 'dan', globalRoles: ['ROOT'] });
      const gate = authorizeByRoles({ roles: ['ADMIN'], allTenants: [] });
      expect(await gate({ auth: { user: { id: 'dan' } } })).toEqual({
        allowed: true,
        tenants: '*',
      });
    });
  });
});
