import { describe, expect, it } from 'vitest';
import AuthzProvider from '../providers/authz_provider.js';
import { AuthzService } from '../src/authz_service.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

/**
 * The reverse seams (`resolveRoleMembers`, `resolveGlobalRoleMembers`) are only useful if they flow
 * from `config/authz.ts` (an `AuthzConfig`) through the provider into the constructed `AuthzService`.
 * The service-level unit tests pass them to the constructor directly and so cannot catch a provider
 * that forgets to forward them — this exercises the config → provider → service path end to end.
 *
 * A minimal fake app: the provider only touches `config.get('authz', …)` and a container with
 * `singleton`/`make` (plus `setBootedApp(app)`, which is inert here).
 */
function appWithAuthzConfig(authzConfig: unknown) {
  const singletons = new Map<unknown, () => Promise<unknown>>();
  const instances = new Map<unknown, unknown>();
  return {
    config: { get: (key: string, dflt: unknown) => (key === 'authz' ? authzConfig : dflt) },
    container: {
      singleton: (token: unknown, factory: () => Promise<unknown>) =>
        singletons.set(token, factory),
      make: async (token: unknown) => {
        if (!instances.has(token)) instances.set(token, await singletons.get(token)?.());
        return instances.get(token);
      },
    },
  };
}

describe('AuthzProvider config plumbing (reverse seams)', () => {
  it('forwards resolveRoleMembers from config into subjectsWithRole', async () => {
    const app = appWithAuthzConfig({
      default: 'mem',
      stores: { mem: async () => new MemoryPermissionStore() },
      resolveRoleMembers: (role: string) => (role === 'ADMIN' ? ['u-admin'] : []),
    });
    new AuthzProvider(app as never).register();
    const authz = (await app.container.make(AuthzService)) as AuthzService;

    expect(await authz.subjectsWithRole('ADMIN')).toEqual([{ type: 'user', id: 'u-admin' }]);
    expect(await authz.subjectsWithRole('OTHER')).toEqual([]);
  });

  it('forwards resolveGlobalRoleMembers from config into subjectsWithRole', async () => {
    const app = appWithAuthzConfig({
      default: 'mem',
      stores: { mem: async () => new MemoryPermissionStore() },
      resolveGlobalRoleMembers: (role: string) => (role === 'ADMIN' ? ['g-admin'] : []),
    });
    new AuthzProvider(app as never).register();
    const authz = (await app.container.make(AuthzService)) as AuthzService;

    expect(await authz.subjectsWithRole('ADMIN')).toEqual([{ type: 'user', id: 'g-admin' }]);
  });
});

describe('AuthzProvider dev tools', () => {
  function appWithHub(authzConfig: unknown) {
    const app = appWithAuthzConfig(authzConfig);
    const registered: Array<{ lib: string; tools: unknown[] }> = [];
    const hub = {
      version: 1,
      supports: (feature: string) => feature === 'endpoint-authorize',
      register: (lib: { lib: string; tools: unknown[] }) => registered.push(lib),
    };
    const make = app.container.make;
    const container = Object.assign(app.container, {
      hasBinding: (key: string) => key === 'agora.devTools',
      make: async (token: unknown) => (token === 'agora.devTools' ? hub : make(token)),
    });
    return { app: { ...app, container }, registered };
  }

  const base = { default: 'mem', stores: { mem: async () => new MemoryPermissionStore() } };

  it('registers the authz tools in boot() when the dev-tools hub exists', async () => {
    const { app, registered } = appWithHub(base);
    const provider = new AuthzProvider(app as never);
    provider.register();
    await provider.boot();
    expect(registered.map((l) => l.lib)).toEqual(['authz']);
  });

  it('registers nothing with devTools: false', async () => {
    const { app, registered } = appWithHub({ ...base, devTools: false });
    const provider = new AuthzProvider(app as never);
    provider.register();
    await provider.boot();
    expect(registered).toEqual([]);
  });
});
