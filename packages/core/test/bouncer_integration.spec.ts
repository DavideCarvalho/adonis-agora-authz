import { Bouncer } from '@adonisjs/bouncer';
import { describe, expect, it } from 'vitest';
import { AuthzService } from '../src/authz_service.js';
import { defineAuthzAbilities } from '../src/bouncer/abilities.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

class User {
  constructor(public id: string) {}
}

async function setup() {
  const store = new MemoryPermissionStore();
  await store.givePermissionToRole('editor', 'posts.*');
  await store.assignRole({ type: 'user', id: '1' }, 'editor');
  await store.assignRole({ type: 'user', id: '1' }, 'admin');

  const service = new AuthzService({ store });
  const abilities = defineAuthzAbilities(service);
  return { abilities };
}

describe('Bouncer integration', () => {
  it('allows a permission backed by the store (with wildcards)', async () => {
    const { abilities } = await setup();
    const bouncer = new Bouncer(new User('1'), abilities);
    expect(await bouncer.allows('can', 'posts.edit')).toBe(true);
    expect(await bouncer.allows('can', 'posts.delete')).toBe(true);
  });

  it('denies a permission the user lacks', async () => {
    const { abilities } = await setup();
    const bouncer = new Bouncer(new User('1'), abilities);
    expect(await bouncer.denies('can', 'comments.delete')).toBe(true);
  });

  it('denies a permission for a different user', async () => {
    const { abilities } = await setup();
    const bouncer = new Bouncer(new User('2'), abilities);
    expect(await bouncer.allows('can', 'posts.edit')).toBe(false);
  });

  it('checks roles via the hasRole ability', async () => {
    const { abilities } = await setup();
    const bouncer = new Bouncer(new User('1'), abilities);
    expect(await bouncer.allows('hasRole', 'admin')).toBe(true);
    expect(await bouncer.allows('hasRole', 'superuser')).toBe(false);
  });

  it('denies a guest (no user)', async () => {
    const { abilities } = await setup();
    const bouncer = new Bouncer<User, typeof abilities>(null, abilities);
    expect(await bouncer.allows('can', 'posts.edit')).toBe(false);
  });
});

describe('defineAuthzAbilities() with no argument', () => {
  it('resolves the container-bound service lazily — on the first check, not at definition', async () => {
    const { setBootedApp } = await import('../services/booted_app.js');
    const store = new MemoryPermissionStore();
    await store.assignRole({ type: 'user', id: '7' }, 'admin');
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

    const abilities = defineAuthzAbilities();
    expect(resolved).toBe(0);
    const bouncer = new Bouncer(new User('7'), abilities);
    expect(await bouncer.allows('hasRole', 'admin')).toBe(true);
    expect(await bouncer.allows('hasRole', 'editor')).toBe(false);
  });
});
