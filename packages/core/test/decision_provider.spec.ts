import { Bouncer } from '@adonisjs/bouncer';
import { describe, expect, it, vi } from 'vitest';
import { AuthzService, type AuthzServiceOptions } from '../src/authz_service.js';
import { defineAuthzAbilities } from '../src/bouncer/abilities.js';
import type { DecisionProvider } from '../src/decision_provider.js';
import { eq, ScopeRegistry, scopeAll, scopeNone } from '../src/scope.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

class Post {
  constructor(
    readonly id: number,
    readonly ownerId = '1',
  ) {}
}

class User {
  constructor(
    readonly id: string,
    readonly admin = false,
  ) {}
}

/** A store where user 1 is an editor (`posts.*`) and user 2 has nothing. */
async function service(
  decisionProvider: DecisionProvider | undefined,
  options: Partial<AuthzServiceOptions> = {},
): Promise<AuthzService> {
  const store = new MemoryPermissionStore();
  await store.givePermissionToRole('editor', 'posts.*');
  await store.assignRole({ type: 'user', id: '1' }, 'editor');
  const scopes = new ScopeRegistry().register(Post, ({ user }) => eq('owner_id', user.id));
  return new AuthzService({
    store,
    scopes,
    ...(decisionProvider ? { decisionProvider } : {}),
    ...options,
  });
}

describe('DecisionProvider seam — AuthzService.can / check', () => {
  it('an explicit deny overrides an RBAC grant', async () => {
    const authz = await service({ decide: () => false });
    expect(await authz.can(new User('1'), 'posts.edit', { resource: new Post(1) })).toBe(false);
  });

  it('an explicit allow overrides a missing grant', async () => {
    const authz = await service({ decide: () => true });
    expect(await authz.can(new User('2'), 'posts.edit', { resource: new Post(1) })).toBe(true);
  });

  it('abstaining (undefined/null) falls through to RBAC', async () => {
    for (const verdict of [undefined, null]) {
      const authz = await service({ decide: () => verdict });
      expect(await authz.can(new User('1'), 'posts.edit')).toBe(true);
      expect(await authz.can(new User('2'), 'posts.edit')).toBe(false);
    }
  });

  it('receives the host user, ability, resource and the resolved ref/tenant', async () => {
    const decide = vi.fn().mockReturnValue(undefined);
    const authz = await service({ decide }, { tenant: () => 'acme' });
    const user = new User('1');
    const post = new Post(9);
    await authz.can(user, 'posts.edit', { resource: post });
    expect(decide).toHaveBeenCalledWith(user, 'posts.edit', post, {
      ref: { type: 'user', id: '1' },
      tenant: { tenantId: 'acme' },
    });
  });

  it('runs AFTER superAdmin: a super-admin verdict never reaches the provider', async () => {
    const decide = vi.fn().mockReturnValue(false);
    const authz = await service(
      { decide },
      { superAdmin: (ref) => (ref.id === '5' ? true : undefined) },
    );
    expect(await authz.can(new User('5'), 'posts.edit', { resource: new Post(1) })).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it('superAdmin receives the resource (to scope a bypass); 2 args without one', async () => {
    const superAdmin = vi.fn().mockReturnValue(undefined);
    const authz = await service(undefined, { superAdmin });
    const post = new Post(1);
    await authz.can(new User('1'), 'posts.edit', { resource: post });
    expect(superAdmin).toHaveBeenLastCalledWith({ type: 'user', id: '1' }, 'posts.edit', post);
    await authz.can(new User('1'), 'posts.edit');
    expect(superAdmin).toHaveBeenLastCalledWith({ type: 'user', id: '1' }, 'posts.edit');
  });

  it('is consulted for anonymous callers and may allow them', async () => {
    const decide = vi.fn().mockReturnValue(true);
    const authz = await service({ decide });
    expect(await authz.can(null, 'posts.view', { resource: new Post(1) })).toBe(true);
    expect(decide).toHaveBeenCalledWith(null, 'posts.view', expect.any(Post), {
      ref: undefined,
      tenant: undefined,
    });
    // Abstaining keeps the anonymous deny.
    const abstain = await service({ decide: () => undefined });
    expect(await abstain.check(null, 'posts.view')).toEqual({
      allowed: false,
      reason: 'anonymous',
    });
  });

  it('check() surfaces the reason and the provider message', async () => {
    const denying = await service({
      decide: () => ({ allowed: false, message: 'blocked by PDP' }),
    });
    expect(await denying.check(new User('1'), 'posts.edit')).toEqual({
      allowed: false,
      reason: 'decision-provider',
      message: 'blocked by PDP',
    });
    const abstaining = await service({ decide: () => undefined });
    expect(await abstaining.check(new User('1'), 'posts.edit')).toEqual({
      allowed: true,
      reason: 'permission',
    });
    expect(await abstaining.check(new User('2'), 'posts.edit')).toEqual({
      allowed: false,
      reason: 'no-grant',
    });
  });

  it('role checks are not routed through the provider', async () => {
    const decide = vi.fn().mockReturnValue(false);
    const authz = await service({ decide });
    expect(await authz.hasRole(new User('1'), 'editor')).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('DecisionProvider seam — batches (canMany / checkMany)', () => {
  it('calls decideMany ONCE and uses its verdicts in order', async () => {
    const decide = vi.fn();
    const decideMany = vi.fn().mockResolvedValue([true, undefined, false]);
    const authz = await service({ decide, decideMany });
    const results = await authz.canMany(new User('1'), [
      { permission: 'comments.delete', resource: new Post(1) }, // provider allows
      { permission: 'posts.edit', resource: new Post(2) }, // abstain → RBAC grant → true
      { permission: 'posts.edit', resource: new Post(3) }, // provider denies
    ]);
    expect(results).toEqual([true, true, false]);
    expect(decideMany).toHaveBeenCalledOnce();
    expect(decide).not.toHaveBeenCalled();
  });

  it('only sends the items super-admin did not decide', async () => {
    const decideMany = vi.fn().mockResolvedValue([false]);
    const authz = await service(
      { decide: vi.fn(), decideMany },
      { superAdmin: (_ref, ability) => (ability === 'admin.only' ? true : undefined) },
    );
    const results = await authz.checkMany(new User('2'), [
      { permission: 'admin.only' },
      { permission: 'posts.edit', resource: new Post(1) },
    ]);
    expect(results.map((r) => r.reason)).toEqual(['super-admin', 'decision-provider']);
    expect(decideMany).toHaveBeenCalledWith(
      expect.any(User),
      [{ ability: 'posts.edit', resource: expect.any(Post) }],
      { ref: { type: 'user', id: '2' }, tenant: undefined },
    );
  });

  it('falls back to per-item decide when decideMany throws or miscounts', async () => {
    for (const decideMany of [
      vi.fn().mockRejectedValue(new Error('down')),
      vi.fn().mockResolvedValue([true, true]),
    ]) {
      const decide = vi.fn().mockReturnValue(true);
      const authz = await service({ decide, decideMany });
      const results = await authz.canMany(new User('2'), [{ permission: 'posts.edit' }]);
      expect(results).toEqual([true]);
      expect(decide).toHaveBeenCalledOnce();
    }
  });

  it('works without a provider (plain RBAC, one shared cache)', async () => {
    const authz = await service(undefined);
    expect(
      await authz.canMany(new User('1'), [
        { permission: 'posts.edit' },
        { permission: 'comments.edit' },
      ]),
    ).toEqual([true, false]);
    expect(await authz.canMany(new User('1'), [])).toEqual([]);
  });
});

describe('DecisionProvider seam — scope / accessibleBy', () => {
  it('uses planScope, and falls back to the registered filter when it abstains', async () => {
    const planned = await service({ decide: () => undefined, planScope: () => scopeNone });
    expect(await planned.scope(new User('2'), Post)).toEqual(scopeNone);

    const abstain = await service({ decide: () => undefined, planScope: () => undefined });
    expect(await abstain.scope(new User('2'), Post)).toEqual(eq('owner_id', '2'));
  });

  it('planScope wins over a permission grant (runs right after super-admin)', async () => {
    const authz = await service({
      decide: () => undefined,
      planScope: () => eq('status', 'published'),
    });
    // user 1 holds `posts.*` — which would be allow-all without the provider.
    expect(await authz.scope(new User('1'), Post, { action: 'posts.view' })).toEqual(
      eq('status', 'published'),
    );
  });

  it('superAdmin wins over planScope and receives the resource key', async () => {
    const planScope = vi.fn().mockReturnValue(scopeNone);
    const superAdmin = vi.fn().mockReturnValue(true);
    const authz = await service({ decide: () => undefined, planScope }, { superAdmin });
    expect(await authz.scope(new User('1'), Post)).toEqual(scopeAll);
    expect(planScope).not.toHaveBeenCalled();
    expect(superAdmin).toHaveBeenCalledWith({ type: 'user', id: '1' }, 'viewAny', Post);
  });

  it('is consulted for anonymous users; abstaining keeps deny-all', async () => {
    const planScope = vi.fn().mockReturnValue(eq('public', true));
    const authz = await service({ decide: () => undefined, planScope });
    expect(await authz.scope(null, Post)).toEqual(eq('public', true));
    expect(planScope).toHaveBeenCalledWith(null, Post, 'viewAny', {
      ref: undefined,
      tenant: undefined,
    });
    const abstain = await service({ decide: () => undefined, planScope: () => undefined });
    expect(await abstain.scope(null, Post)).toEqual(scopeNone);
  });
});

describe('DecisionProvider seam — Bouncer `can` ability', () => {
  it('forwards the resource and surfaces the provider deny message', async () => {
    const decide = vi.fn().mockReturnValue({ allowed: false, message: 'Cerbos says no' });
    const abilities = defineAuthzAbilities(await service({ decide }));
    const bouncer = new Bouncer(new User('1'), abilities);
    const post = new Post(1);
    const response = await bouncer.execute('can', 'posts.edit', post);
    expect(response.authorized).toBe(false);
    expect(response.message).toBe('Cerbos says no');
    expect(decide).toHaveBeenCalledWith(expect.any(User), 'posts.edit', post, expect.anything());
  });

  it('keeps the default deny message when RBAC denies', async () => {
    const abilities = defineAuthzAbilities(await service({ decide: () => undefined }));
    const bouncer = new Bouncer(new User('2'), abilities);
    const response = await bouncer.execute('can', 'posts.edit');
    expect(response.authorized).toBe(false);
    expect(response.message).toBe('Missing permission: posts.edit');
  });

  it('still accepts a minimal custom service with only can/hasRole', async () => {
    const can = vi.fn().mockResolvedValue(true);
    const abilities = defineAuthzAbilities({ can, hasRole: vi.fn() });
    const post = new Post(1);
    expect(await new Bouncer(new User('1'), abilities).allows('can', 'posts.edit', post)).toBe(
      true,
    );
    expect(can).toHaveBeenCalledWith(expect.any(User), 'posts.edit', { resource: post });
  });
});
