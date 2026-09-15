import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('authz service singleton', () => {
  beforeEach(() => {
    // Fresh module each test so the module-level memoization and captured app start empty.
    vi.resetModules();
  });

  it('throws a clear error when used before the provider set the booted app', async () => {
    const { default: service } = await import('./main.js');
    await expect(service.can({ id: 'u1' }, 'metrics.read')).rejects.toThrow(
      /AuthzProvider registered/,
    );
  });

  it('resolves the AuthzService from the captured app once and reuses it across calls', async () => {
    const authz = { can: vi.fn().mockResolvedValue(true) };
    const make = vi.fn().mockResolvedValue(authz);
    const { setBootedApp } = await import('./booted_app.js');
    setBootedApp({ container: { make } } as never);
    const { default: service } = await import('./main.js');

    await expect(service.can({ id: 'u1' }, 'metrics.read')).resolves.toBe(true);
    await service.can({ id: 'u1' }, 'metrics.write');

    // One container resolution, shared by every forwarded call.
    expect(make).toHaveBeenCalledTimes(1);
    expect(authz.can).toHaveBeenNthCalledWith(1, { id: 'u1' }, 'metrics.read');
    expect(authz.can).toHaveBeenNthCalledWith(2, { id: 'u1' }, 'metrics.write');
  });

  it('forwards every async method to the resolved instance', async () => {
    const authz = {
      can: vi.fn().mockResolvedValue(true),
      scope: vi.fn().mockResolvedValue('scope-all'),
      hasRole: vi.fn().mockResolvedValue(true),
      hasAnyRole: vi.fn().mockResolvedValue(false),
      effectiveRoles: vi.fn().mockResolvedValue(['paciente']),
      effectivePermissions: vi.fn().mockResolvedValue(['metrics.read']),
    };
    const { setBootedApp } = await import('./booted_app.js');
    setBootedApp({ container: { make: vi.fn().mockResolvedValue(authz) } } as never);
    const { default: service } = await import('./main.js');

    await expect(service.scope({ id: 'u1' }, 'exam')).resolves.toBe('scope-all');
    await expect(service.hasRole({ id: 'u1' }, 'paciente')).resolves.toBe(true);
    await expect(service.hasAnyRole({ id: 'u1' }, ['admin'])).resolves.toBe(false);
    await expect(service.effectiveRoles({ id: 'u1' })).resolves.toEqual(['paciente']);
    await expect(service.effectivePermissions({ id: 'u1' })).resolves.toEqual(['metrics.read']);
  });
});

describe('authz service singleton — store and cache', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('forwards every store method lazily, including a withClient view', async () => {
    const view = { assignRole: vi.fn().mockResolvedValue(undefined) };
    const store = {
      assignRole: vi.fn().mockResolvedValue(undefined),
      listRoles: vi.fn().mockResolvedValue(['editor']),
      withClient: vi.fn().mockReturnValue(view),
    };
    const make = vi.fn().mockResolvedValue({ store });
    const { setBootedApp } = await import('./booted_app.js');
    setBootedApp({ container: { make } } as never);
    const { default: service } = await import('./main.js');

    expect(make).not.toHaveBeenCalled(); // touching `.store` resolves nothing yet
    const s = service.store;
    expect(make).not.toHaveBeenCalled();

    await s.assignRole({ type: 'user', id: '1' }, 'editor');
    await expect(s.listRoles()).resolves.toEqual(['editor']);
    expect(store.assignRole).toHaveBeenCalledWith({ type: 'user', id: '1' }, 'editor');

    const trx = { rawQuery: vi.fn() };
    await s.withClient(trx).assignRole({ type: 'user', id: '2' }, 'editor');
    expect(store.withClient).toHaveBeenCalledWith(trx);
    expect(view.assignRole).toHaveBeenCalledWith({ type: 'user', id: '2' }, 'editor');
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('createCache() is sync and memoizes over the lazily-resolved service', async () => {
    const store = {
      getRolesForSubject: vi.fn().mockResolvedValue(['editor']),
      getPermissionsForSubject: vi.fn().mockResolvedValue(['posts.edit']),
      getRolePermissions: vi.fn().mockResolvedValue([]),
    };
    const authz = {
      store,
      effectiveRolesForRef: vi.fn().mockResolvedValue(['editor', 'from-token']),
    };
    const { setBootedApp } = await import('./booted_app.js');
    setBootedApp({ container: { make: vi.fn().mockResolvedValue(authz) } } as never);
    const { default: service } = await import('./main.js');

    const cache = service.createCache();
    const ref = { type: 'user', id: '1' };
    await expect(cache.getRoles(ref)).resolves.toEqual(['editor', 'from-token']);
    await cache.getRoles(ref);
    // The service's union (not the raw store) is what the cache memoizes — once.
    expect(authz.effectiveRolesForRef).toHaveBeenCalledTimes(1);
  });
});
