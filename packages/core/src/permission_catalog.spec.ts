import { afterEach, describe, expect, it } from 'vitest';
import { AUTHZ_CATALOG_SLOT, publishAuthzCatalog, readAuthzCatalog } from './agora/catalog_slot.js';
import { AuthzService } from './authz_service.js';
import { MemoryPermissionStore } from './stores/memory.js';

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[AUTHZ_CATALOG_SLOT];
});

describe('permissionCatalog', () => {
  it('unions the config catalog, roleGrants and the store, sorted and deduped', async () => {
    const store = new MemoryPermissionStore();
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.createPermission('reports:export');
    const service = new AuthzService({
      store,
      catalog: { permissions: ['media:objects:read'], roles: { viewer: ['posts.view'] } },
      roleGrants: { auditor: ['audit.*', 'posts.view'] },
    });
    expect(await service.permissionCatalog()).toEqual([
      'audit.*',
      'media:objects:read',
      'posts.edit',
      'posts.view',
      'reports:export',
    ]);
  });

  it('is empty without any declared permission', async () => {
    const service = new AuthzService({ store: new MemoryPermissionStore() });
    expect(await service.permissionCatalog()).toEqual([]);
  });
});

describe('catalog slot', () => {
  it('reads what was published, and nothing before', async () => {
    expect(readAuthzCatalog()).toBeUndefined();
    publishAuthzCatalog({ permissions: async () => ['a:b'] });
    expect(await readAuthzCatalog()?.permissions()).toEqual(['a:b']);
  });

  it('ignores a malformed slot', () => {
    (globalThis as Record<symbol, unknown>)[AUTHZ_CATALOG_SLOT] = { permissions: 1 };
    expect(readAuthzCatalog()).toBeUndefined();
  });
});
