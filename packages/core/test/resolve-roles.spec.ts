import { afterEach, describe, expect, it } from 'vitest';
import { AuthzService } from '../src/authz_service.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

const ACCESSOR = Symbol.for('@agora/context:accessor');
type Slots = Record<symbol, unknown>;
function setContextRoles(roles: string[]): void {
  (globalThis as Slots)[ACCESSOR] = { get: () => ({ globalRoles: roles }) };
}
afterEach(() => {
  delete (globalThis as Slots)[ACCESSOR];
});

function svc(opts: Partial<ConstructorParameters<typeof AuthzService>[0]> = {}) {
  return new AuthzService({ store: new MemoryPermissionStore(), ...opts });
}

describe('resolveRoles seam + roleGrants', () => {
  it('grants a permission from an app-role returned by resolveRoles', async () => {
    const authz = svc({
      resolveRoles: async (ref) => (ref.id === 'u1' ? ['COORDINATOR'] : []),
      roleGrants: { COORDINATOR: ['agent.coordenador.*'] },
    });
    expect(await authz.can({ id: 'u1' }, 'agent.coordenador.reatribuir')).toBe(true);
    expect(await authz.can({ id: 'u2' }, 'agent.coordenador.reatribuir')).toBe(false);
  });

  it('unions resolver roles with context (token) roles under roleGrants', async () => {
    setContextRoles(['ADMIN']);
    const authz = svc({
      resolveRoles: async () => ['COORDINATOR'],
      roleGrants: { ADMIN: ['sys.*'], COORDINATOR: ['agent.coordenador.*'] },
    });
    expect(await authz.can({ id: 'u1' }, 'sys.reboot')).toBe(true); // do token
    expect(await authz.can({ id: 'u1' }, 'agent.coordenador.reatribuir')).toBe(true); // do resolver
  });

  it('without resolveRoles, only context roles + store decide (fail-closed default)', async () => {
    const authz = svc({ roleGrants: { COORDINATOR: ['agent.coordenador.*'] } });
    expect(await authz.can({ id: 'u1' }, 'agent.coordenador.reatribuir')).toBe(false);
  });

  it('hasRole reflects resolver roles', async () => {
    const authz = svc({ resolveRoles: async () => ['COORDINATOR'] });
    expect(await authz.hasRole({ id: 'u1' }, 'COORDINATOR')).toBe(true);
    expect(await authz.hasRole({ id: 'u1' }, 'ADMIN')).toBe(false);
  });

  it('hasAnyRole agrees with hasRole: recognizes a resolver-only role', async () => {
    const authz = svc({ resolveRoles: async () => ['COORDINATOR'] });
    expect(await authz.hasAnyRole({ id: 'u1' }, ['COORDINATOR'])).toBe(true);
    expect(await authz.hasAnyRole({ id: 'u1' }, ['ADMIN', 'COORDINATOR'])).toBe(true);
    expect(await authz.hasAnyRole({ id: 'u1' }, ['ADMIN'])).toBe(false);
  });
});

describe('effectiveRoles / effectivePermissions (public API)', () => {
  it('effectiveRoles unions context (token) + resolveRoles + store, deduplicated', async () => {
    setContextRoles(['ADMIN', 'SHARED']);
    const store = new MemoryPermissionStore();
    await store.assignRole({ type: 'user', id: 'u1' }, 'STORE_ROLE');
    await store.assignRole({ type: 'user', id: 'u1' }, 'SHARED');
    const authz = svc({
      store,
      resolveRoles: async () => ['COORDINATOR', 'SHARED'],
    });

    const roles = await authz.effectiveRoles({ id: 'u1' });
    expect(new Set(roles)).toEqual(new Set(['ADMIN', 'SHARED', 'COORDINATOR', 'STORE_ROLE']));
    // deduplicated: SHARED comes from both context and resolver, appears once.
    expect(roles.filter((r) => r === 'SHARED')).toHaveLength(1);
  });

  it('effectiveRoles returns [] for an unresolved user', async () => {
    const authz = svc();
    expect(await authz.effectiveRoles(undefined)).toEqual([]);
  });

  it('effectivePermissions unions store-granted permissions with roleGrants over effective roles', async () => {
    setContextRoles(['ADMIN']);
    const store = new MemoryPermissionStore();
    await store.giveSubjectPermission({ type: 'user', id: 'u1' }, 'direct.permission');
    const authz = svc({
      store,
      resolveRoles: async () => ['COORDINATOR'],
      roleGrants: { ADMIN: ['sys.*'], COORDINATOR: ['agent.coordenador.*'] },
    });

    const perms = await authz.effectivePermissions({ id: 'u1' });
    expect(new Set(perms)).toEqual(new Set(['direct.permission', 'sys.*', 'agent.coordenador.*']));
  });
});
