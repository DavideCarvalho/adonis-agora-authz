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
