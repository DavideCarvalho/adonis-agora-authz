import { Bouncer } from '@adonisjs/bouncer';
import { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGORA_CONTEXT_ACCESSOR } from '../src/agora/context.js';
import { AuthzService } from '../src/authz_service.js';
import { defineAuthzAbilities } from '../src/bouncer/abilities.js';
import { type CanResponse, registerCanEndpoint } from '../src/http.js';
import { hasPermissions } from '../src/mixins.js';
import { PermissionCache } from '../src/permission_cache.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

type GlobalSlots = Record<symbol, unknown>;

/** Enter a fake Agora request: the accessor's `get()` returns one store object. */
function enterRequest(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  (globalThis as GlobalSlots)[AGORA_CONTEXT_ACCESSOR] = { get: () => store };
  return store;
}

class User {
  constructor(
    public id: string,
    public type = 'user',
  ) {}
}

async function setup(opts: Partial<ConstructorParameters<typeof AuthzService>[0]> = {}) {
  const store = new MemoryPermissionStore();
  for (let i = 0; i < 20; i++) await store.givePermissionToRole('editor', `reports.r${i}`);
  await store.givePermissionToRole('editor', 'posts.*');
  await store.assignRole({ type: 'user', id: '1' }, 'editor');
  const service = new AuthzService({ store, ...opts });
  const reads = {
    roles: vi.spyOn(store, 'getRolesForSubject'),
    permissions: vi.spyOn(store, 'getPermissionsForSubject'),
  };
  return { store, service, reads };
}

afterEach(() => {
  delete (globalThis as GlobalSlots)[AGORA_CONTEXT_ACCESSOR];
  vi.restoreAllMocks();
});

describe('per-request cache by default', () => {
  it('a 50-row list with 2 checks per row reads roles and permissions once', async () => {
    const { service, reads } = await setup();
    enterRequest();
    const user = new User('1');

    for (let row = 0; row < 50; row++) {
      expect(await service.can(user, 'posts.update', { resource: { row } })).toBe(true);
      expect(await service.can(user, 'comments.delete', { resource: { row } })).toBe(false);
    }

    expect(reads.roles).toHaveBeenCalledTimes(1);
    expect(reads.permissions).toHaveBeenCalledTimes(1);
  });

  it('hasRole / hasAnyRole / effectiveRoles share the request read', async () => {
    const { service, reads } = await setup();
    enterRequest();
    const user = new User('1');

    expect(await service.hasRole(user, 'editor')).toBe(true);
    expect(await service.hasRole(user, 'admin')).toBe(false);
    expect(await service.hasAnyRole(user, ['admin', 'editor'])).toBe(true);
    expect(await service.effectiveRoles(user)).toEqual(['editor']);
    expect(await service.can(user, 'posts.edit')).toBe(true);

    expect(reads.roles).toHaveBeenCalledTimes(1);
  });

  it('user.can() on the mixin, Bouncer abilities and /authz/can all hit the request cache', async () => {
    const { service, reads } = await setup();
    enterRequest();

    class Base {
      constructor(public id: string) {}
    }
    const Model = hasPermissions(() => service)(Base);
    const model = new Model('1');
    const bouncer = new Bouncer(new User('1'), defineAuthzAbilities(service));
    let handler: ((ctx: unknown) => Promise<CanResponse>) | undefined;
    registerCanEndpoint(
      {
        post: (_path: string, h: (ctx: never) => Promise<CanResponse>) => {
          handler = h as (ctx: unknown) => Promise<CanResponse>;
        },
      },
      { service },
    );

    for (let i = 0; i < 10; i++) {
      expect(await model.can('posts.edit')).toBe(true);
      expect(await bouncer.allows('can', 'posts.edit')).toBe(true);
      expect(await bouncer.allows('hasRole', 'editor')).toBe(true);
      expect(
        await handler?.({
          request: { body: () => ({ permission: 'posts.edit' }) },
          auth: { user: new User('1') },
        }),
      ).toEqual({ allowed: true });
    }

    expect(reads.roles).toHaveBeenCalledTimes(1);
    expect(reads.permissions).toHaveBeenCalledTimes(1);
  });

  it('falls back to the AdonisJS HttpContext when there is no Agora context', async () => {
    const { service, reads } = await setup();
    const ctx = {} as HttpContext;
    vi.spyOn(HttpContext, 'get').mockImplementation(() => ctx);
    const user = new User('1');

    for (let i = 0; i < 10; i++) expect(await service.can(user, 'posts.edit')).toBe(true);

    expect(reads.permissions).toHaveBeenCalledTimes(1);
  });

  it('a new request sees grants made after the previous one', async () => {
    const { store, service, reads } = await setup();
    const user = new User('2');

    enterRequest();
    expect(await service.can(user, 'posts.edit')).toBe(false);
    await store.assignRole({ type: 'user', id: '2' }, 'editor');
    expect(await service.can(user, 'posts.edit')).toBe(false); // same request: snapshot

    enterRequest();
    expect(await service.can(user, 'posts.edit')).toBe(true);
    expect(reads.permissions).toHaveBeenCalledTimes(2);
  });

  it('keeps users and tenants apart within one request', async () => {
    const { store, service } = await setup();
    await store.assignRole({ type: 'user', id: '3' }, 'editor', { tenantId: 'acme' });
    enterRequest();

    expect(await service.can(new User('3'), 'posts.edit')).toBe(false);
    expect(await service.can(new User('3'), 'posts.edit', { scope: { tenantId: 'acme' } })).toBe(
      true,
    );
    expect(await service.can(new User('1'), 'posts.edit')).toBe(true);
    expect(await service.can(new User('4'), 'posts.edit')).toBe(false);
  });

  it('applies roleGrants through the cached matcher', async () => {
    const { service, reads } = await setup({ roleGrants: { editor: ['billing.*'] } });
    enterRequest();
    const user = new User('1');

    expect(await service.can(user, 'billing.refund')).toBe(true);
    expect(await service.can(user, 'billing')).toBe(false);
    expect(await service.can(user, 'posts.edit')).toBe(true);
    expect(reads.permissions).toHaveBeenCalledTimes(1);
  });

  it('retries a read that failed instead of caching the failure', async () => {
    const { service, reads } = await setup();
    enterRequest();
    reads.permissions.mockRejectedValueOnce(new Error('connection reset'));
    const user = new User('1');

    await expect(service.can(user, 'posts.edit')).rejects.toThrow('connection reset');
    expect(await service.can(user, 'posts.edit')).toBe(true);
  });

  it('outside a request every call still reads the store', async () => {
    const { service, reads } = await setup();
    const user = new User('1');

    await service.can(user, 'posts.edit');
    await service.can(user, 'posts.edit');

    expect(reads.permissions).toHaveBeenCalledTimes(2);
  });

  it('matching a 200-grant set does not re-split every grant per check', async () => {
    const store = new MemoryPermissionStore();
    for (let i = 0; i < 200; i++) {
      await store.givePermissionToRole('editor', `module${i % 20}.resource${i}.action`);
    }
    await store.assignRole({ type: 'user', id: '1' }, 'editor');
    const cache = new PermissionCache(store);
    const ref = { type: 'user', id: '1' };
    await cache.satisfies(ref, 'warm.up');

    const split = vi.spyOn(String.prototype, 'split');
    for (let i = 0; i < 100; i++) expect(await cache.satisfies(ref, 'posts.update')).toBe(false);
    // Re-matching every grant would be 200 x 2 splits per check (40k in total).
    expect(split.mock.calls.length).toBeLessThan(100);
  });
});
