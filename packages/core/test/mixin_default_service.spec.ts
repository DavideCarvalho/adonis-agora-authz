import { describe, expect, it } from 'vitest';
import { AuthzService } from '../src/authz_service.js';
import { hasPermissions } from '../src/mixins.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

/**
 * `hasPermissions()` with no resolver uses the library's container-bound service,
 * resolved on the first call. The model file needs no `app` import and can be
 * evaluated before boot — the container is only touched when a method runs.
 */
describe('hasPermissions() default service', () => {
  it('reaches the provider-captured app lazily and delegates to its store', async () => {
    const { setBootedApp } = await import('../services/booted_app.js');
    const store = new MemoryPermissionStore();
    const service = new AuthzService({ store });
    let resolved = 0;
    setBootedApp({
      container: {
        make: async () => {
          resolved += 1;
          return service;
        },
      },
    } as never);

    class Base {
      constructor(public id: string) {}
    }
    class User extends hasPermissions()(Base) {}
    expect(resolved).toBe(0);

    const user = new User('42');
    await user.assignRole('editor');
    expect(await user.hasRole('editor')).toBe(true);
    expect(await store.getRolesForSubject({ type: 'user', id: '42' })).toEqual(['editor']);
  });
});
