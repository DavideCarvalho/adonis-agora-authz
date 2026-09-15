import { describe, expect, it } from 'vitest';
import { AuthzService } from './authz_service.js';
import { PermissionCache } from './permission_cache.js';
import { ScopeRegistry, scopeAll, scopeNone } from './scope.js';
import type { PermissionStore } from './store.js';
import { MemoryPermissionStore } from './stores/memory.js';

class User {
  constructor(
    public id: string,
    public type = 'user',
  ) {}
}

function makeService(opts: Partial<ConstructorParameters<typeof AuthzService>[0]> = {}) {
  const store = new MemoryPermissionStore();
  const service = new AuthzService({ store, ...opts });
  return { store, service };
}

describe('AuthzService', () => {
  it('grants via wildcard permission matching', async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('editor', 'posts.*');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');

    const user = new User('1');
    expect(await service.can(user, 'posts.edit')).toBe(true);
    expect(await service.can(user, 'posts.delete')).toBe(true);
    expect(await service.can(user, 'comments.edit')).toBe(false);
  });

  it('denies an unmappable / anonymous user', async () => {
    const { service } = makeService();
    expect(await service.can(null, 'posts.edit')).toBe(false);
    expect(await service.can({}, 'posts.edit')).toBe(false);
  });

  it('super-admin true short-circuits to allow', async () => {
    const { service } = makeService({ superAdmin: (u) => u.id === '1' });
    expect(await service.can(new User('1'), 'anything.at.all')).toBe(true);
  });

  it('super-admin hook applies consistently to can, hasRole, AND hasAnyRole', async () => {
    const { service } = makeService({ superAdmin: (u) => u.id === '1' });
    const user = new User('1');
    expect(await service.can(user, 'anything.at.all')).toBe(true);
    expect(await service.hasRole(user, 'whatever')).toBe(true);
    expect(await service.hasAnyRole(user, ['whatever', 'else'])).toBe(true);
  });

  it('super-admin false short-circuits to deny', async () => {
    const { store, service } = makeService({ superAdmin: () => false });
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    // Even though the grant exists, the super-admin hook denies.
    expect(await service.can(new User('1'), 'posts.edit')).toBe(false);
  });

  it('checks roles exactly', async () => {
    const { store, service } = makeService();
    await store.assignRole({ type: 'user', id: '1' }, 'admin');
    const user = new User('1');
    expect(await service.hasRole(user, 'admin')).toBe(true);
    expect(await service.hasRole(user, 'editor')).toBe(false);
    expect(await service.hasAnyRole(user, ['editor', 'admin'])).toBe(true);
  });

  it('reads the active tenant from the resolver', async () => {
    let tenant: string | undefined;
    const { store, service } = makeService({ tenant: () => tenant });
    await store.givePermissionToRole('viewer', 'reports.view');
    await store.assignRole({ type: 'user', id: '1' }, 'viewer', { tenantId: 'acme' });

    const user = new User('1');
    tenant = undefined;
    expect(await service.can(user, 'reports.view')).toBe(false);
    tenant = 'acme';
    expect(await service.can(user, 'reports.view')).toBe(true);
  });

  it('honors a custom resolveSubjectRef', async () => {
    const { store, service } = makeService({
      resolveSubjectRef: (u) => ({ type: 'account', id: (u as { uid: string }).uid }),
    });
    await store.givePermissionToRole('owner', 'org.manage');
    await store.assignRole({ type: 'account', id: 'abc' }, 'owner');
    expect(await service.can({ uid: 'abc' }, 'org.manage')).toBe(true);
  });
});

describe('AuthzService.usersWithRole', () => {
  it('unions the store, domain seam, and global seam', async () => {
    const { store, service } = makeService({
      resolveRoleMembers: () => ['2'],
      resolveGlobalRoleMembers: () => ['3'],
    });
    await store.assignRole({ type: 'user', id: '1' }, 'editor');

    const users = await service.usersWithRole('editor');
    expect(users).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '1' },
        { type: 'user', id: '2' },
        { type: 'user', id: '3' },
      ]),
    );
    expect(users).toHaveLength(3);
  });

  it('dedups when the same (type,id) comes from two sources', async () => {
    const { store, service } = makeService({
      resolveRoleMembers: () => ['1'], // same as the store ref below
      resolveGlobalRoleMembers: () => ['1'], // and the global seam too
    });
    await store.assignRole({ type: 'user', id: '1' }, 'editor');

    const users = await service.usersWithRole('editor');
    expect(users).toEqual([{ type: 'user', id: '1' }]);
  });

  it('normalizes bare-string ids to the default user type', async () => {
    const { service } = makeService({
      resolveRoleMembers: () => ['42'],
      resolveGlobalRoleMembers: () => [7], // number id too
    });
    const users = await service.usersWithRole('editor');
    expect(users).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '42' },
        { type: 'user', id: '7' },
      ]),
    );
    expect(users).toHaveLength(2);
  });

  it('normalizes SubjectRefInput objects (keeping their type)', async () => {
    const { service } = makeService({
      resolveRoleMembers: () => [{ type: 'account', id: 'abc' }],
      resolveGlobalRoleMembers: () => [{ id: 9 }], // no type → default 'user'
    });
    const users = await service.usersWithRole('editor');
    expect(users).toEqual(
      expect.arrayContaining([
        { type: 'account', id: 'abc' },
        { type: 'user', id: '9' },
      ]),
    );
    expect(users).toHaveLength(2);
  });

  it('treats absent seams as empty (store-only results)', async () => {
    const { store, service } = makeService();
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    await store.assignRole({ type: 'user', id: '2' }, 'editor');
    const users = await service.usersWithRole('editor');
    expect(users).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '1' },
        { type: 'user', id: '2' },
      ]),
    );
    expect(users).toHaveLength(2);
  });

  it('returns [] for a role nobody holds', async () => {
    const { service } = makeService();
    expect(await service.usersWithRole('ghost')).toEqual([]);
  });

  it('runs the three sources in parallel', async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number, ids: string[]) => () =>
      new Promise<string[]>((r) => {
        order.push(`start:${label}`);
        setTimeout(() => {
          order.push(`end:${label}`);
          r(ids);
        }, ms);
      });
    const { service } = makeService({
      resolveRoleMembers: slow('domain', 30, ['2']),
      resolveGlobalRoleMembers: slow('global', 10, ['3']),
    });
    const users = await service.usersWithRole('editor');
    expect(users).toEqual(
      expect.arrayContaining([
        { type: 'user', id: '2' },
        { type: 'user', id: '3' },
      ]),
    );
    // Both started before either finished → concurrent, not sequential.
    expect(order.slice(0, 2)).toEqual(expect.arrayContaining(['start:domain', 'start:global']));
    expect(order.indexOf('end:global')).toBeLessThan(order.indexOf('end:domain'));
  });

  it('passes the resolved tenant scope to the store and seams', async () => {
    let seamScope: string | undefined = 'unset';
    const { store, service } = makeService({
      tenant: () => 'acme',
      resolveRoleMembers: (_role, scope) => {
        seamScope = scope?.tenantId;
        return [];
      },
    });
    await store.assignRole({ type: 'user', id: '1' }, 'editor', { tenantId: 'acme' });
    // The store's tenant-visibility means the acme assignee shows only under acme scope.
    const users = await service.usersWithRole('editor');
    expect(users).toEqual([{ type: 'user', id: '1' }]);
    expect(seamScope).toBe('acme');
  });
});

/** A store spy counting the two role/permission reads `can()` performs. */
function countingStore(base: PermissionStore) {
  const counts = { roles: 0, perms: 0 };
  const spy = Object.create(base) as PermissionStore;
  spy.getRolesForSubject = (u, s) => {
    counts.roles += 1;
    return base.getRolesForSubject(u, s);
  };
  spy.getPermissionsForSubject = (u, s) => {
    counts.perms += 1;
    return base.getPermissionsForSubject(u, s);
  };
  return { spy, counts };
}

describe('AuthzService caching (issue #75)', () => {
  it('memoizes the ROLE read too: one resolution per (user, tenant) per cache', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('editor', 'posts.*');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    const { spy, counts } = countingStore(store);
    const service = new AuthzService({ store: spy });
    const user = new User('1');

    const cache = service.createCache();
    expect(await service.can(user, 'posts.edit', { cache })).toBe(true);
    expect(await service.can(user, 'posts.delete', { cache })).toBe(true);
    expect(await service.can(user, 'comments.edit', { cache })).toBe(false);
    expect(await service.hasRole(user, 'editor', { cache })).toBe(true);
    expect(await service.hasAnyRole(user, ['ghost', 'editor'], { cache })).toBe(true);
    expect(await service.effectiveRoles(user, undefined, { cache })).toEqual(['editor']);
    expect(await service.effectivePermissions(user, undefined, { cache })).toContain('posts.*');

    // Eight checks, ONE read per dimension — the promise the cache makes.
    expect(counts.roles).toBe(1);
    expect(counts.perms).toBe(1);
  });

  it('without a cache every check re-reads (the N+1 the cache exists to kill)', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    const { spy, counts } = countingStore(store);
    const service = new AuthzService({ store: spy });
    const user = new User('1');

    expect(await service.can(user, 'posts.edit')).toBe(true);
    expect(await service.can(user, 'posts.edit')).toBe(true);
    expect(counts.roles).toBe(2);
    expect(counts.perms).toBe(2);
  });

  it('the cache memoizes the resolveRoles seam, not just the store', async () => {
    const store = new MemoryPermissionStore();
    let seamCalls = 0;
    const service = new AuthzService({
      store,
      resolveRoles: async () => {
        seamCalls += 1;
        return ['COORDINATOR'];
      },
    });
    const user = new User('1');
    const cache = service.createCache();
    expect(await service.hasRole(user, 'COORDINATOR', { cache })).toBe(true);
    expect(await service.hasRole(user, 'COORDINATOR', { cache })).toBe(true);
    expect(await service.effectiveRoles(user, undefined, { cache })).toContain('COORDINATOR');
    // Domain-table role derivation costs one query per request, not per check.
    expect(seamCalls).toBe(1);
  });

  it('decisions stay snapshotted: a mid-request grant does not flip cached checks', async () => {
    const store = new MemoryPermissionStore();
    const service = new AuthzService({ store });
    const user = new User('1');
    const cache = service.createCache();

    expect(await service.can(user, 'posts.edit', { cache })).toBe(false);
    await store.giveSubjectPermission({ type: 'user', id: '1' }, 'posts.edit');
    // Same request, same cache: the decision was made against one state.
    expect(await service.can(user, 'posts.edit', { cache })).toBe(false);
    // A fresh cache (next request) sees the grant.
    expect(await service.can(user, 'posts.edit', { cache: service.createCache() })).toBe(true);
  });

  it('keys by (user, tenant): different tenants resolve independently', async () => {
    const store = new MemoryPermissionStore();
    await store.assignRole({ type: 'user', id: '1' }, 'viewer', { tenantId: 'acme' });
    const { spy, counts } = countingStore(store);
    const service = new AuthzService({ store: spy });
    const user = new User('1');
    const cache = service.createCache();

    expect(await service.hasRole(user, 'viewer', { cache })).toBe(false);
    expect(await service.hasRole(user, 'viewer', { scope: { tenantId: 'acme' }, cache })).toBe(
      true,
    );
    expect(counts.roles).toBe(2);
  });

  it('a standalone cache falls back to store.getRolesForSubject', async () => {
    const store = new MemoryPermissionStore();
    await store.assignRole({ type: 'user', id: '1' }, 'admin');
    const { spy, counts } = countingStore(store);
    const cache = new PermissionCache(spy);
    expect(await cache.getRoles({ type: 'user', id: '1' })).toEqual(['admin']);
    expect(await cache.getRoles({ type: 'user', id: '1' })).toEqual(['admin']);
    expect(counts.roles).toBe(1);
    // Permissions memoize on the same key.
    expect([...(await cache.getPermissions({ type: 'user', id: '1' }))]).toEqual([]);
    expect(counts.perms).toBe(1);
  });

  it('scope() shares the role resolution through the cache', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    const { spy, counts } = countingStore(store);
    const scopes = new ScopeRegistry().register('posts', (ctx) =>
      ctx.roles.includes('editor') ? scopeAll : scopeNone,
    );
    const service = new AuthzService({ store: spy, scopes });
    const user = new User('1');
    const cache = service.createCache();

    expect(await service.can(user, 'posts.edit', { cache })).toBe(true);
    // The filter decision reads the SAME memoized role resolution — a request
    // that gates a collection after gating an action costs one read, not two.
    expect(await service.scope(user, 'posts', { cache })).toEqual(scopeAll);
    expect(counts.roles).toBe(1);
    expect(counts.perms).toBe(1);
  });
});
