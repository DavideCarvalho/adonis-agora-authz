import { describe, expect, it } from 'vitest';
import { runPermissionStoreContract } from '../testing.js';
import { MemoryPermissionStore } from './memory.js';

runPermissionStoreContract('MemoryPermissionStore', () => new MemoryPermissionStore());

describe('MemoryPermissionStore.withClient', () => {
  it('returns the same store — there is no connection to scope', () => {
    const store = new MemoryPermissionStore();
    const view = store.withClient({ rawQuery: async () => [] });
    expect(view).toBe(store);
  });
});
