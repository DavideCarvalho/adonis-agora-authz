import { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCallerOf, appSubjectRef, capabilityAllows, isAppCaller } from './agora/app_caller.js';
import { permitAuthz } from './app_callers.js';
import { AuthzService } from './authz_service.js';
import AuthzRoleMiddleware from './middleware.js';
import { MemoryPermissionStore } from './stores/memory.js';

const makeSpy = vi.fn();
vi.mock('@adonisjs/core/services/app', () => ({
  default: { container: { make: (key: unknown) => makeSpy(key) } },
}));

function makeService(opts: Partial<ConstructorParameters<typeof AuthzService>[0]> = {}) {
  const store = new MemoryPermissionStore();
  const service = new AuthzService({ store, ...opts });
  return { store, service };
}

const hub = { app: 'agora-hub', capabilities: ['media:objects:read', 'payments:*'] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('app callers as subjects', () => {
  it('maps a caller to { type: "app", id }', () => {
    const { service } = makeService();
    expect(service.refOf(hub)).toEqual({ type: 'app', id: 'agora-hub' });
    expect(appSubjectRef('x')).toEqual({ type: 'app', id: 'x' });
  });

  it('never takes a model with an id for a caller', () => {
    const { service } = makeService();
    expect(isAppCaller({ id: 7, app: 'agora-hub' })).toBe(false);
    expect(service.refOf({ id: 7, app: 'agora-hub' })).toEqual({ type: 'user', id: '7' });
    expect(isAppCaller({ app: '' })).toBe(false);
  });

  it("grants the caller's token capabilities, with the capability wildcard", async () => {
    const { service } = makeService();
    expect(await service.can(hub, 'media:objects:read')).toBe(true);
    expect(await service.can(hub, 'payments:charges:refund')).toBe(true);
    expect(await service.can(hub, 'payments')).toBe(true);
    expect(await service.can(hub, 'media:objects:write')).toBe(false);
    expect(await service.can({ app: 'agora-hub' }, 'media:objects:read')).toBe(false);
  });

  it("does not lend one app's capabilities to another app's subject", async () => {
    const { service } = makeService();
    const decision = await service.checkForRef(appSubjectRef('other'), 'media:objects:read', {
      user: hub,
    });
    expect(decision.allowed).toBe(false);
  });

  it('grants an app what the store gives it, with the capability rule on ":" grants', async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('media-reader', 'media:*');
    await store.assignRole(appSubjectRef('cms'), 'media-reader');
    await store.givePermissionToRole('exporter', 'reports.export');
    await store.assignRole(appSubjectRef('cms'), 'exporter');
    const cms = appSubjectRef('cms');
    expect(await service.can(cms, 'media:objects:read')).toBe(true);
    expect(await service.can(cms, 'reports.export')).toBe(true);
    expect(await service.can(cms, 'media')).toBe(true);
    expect(await service.can(cms, 'payments:charges:read')).toBe(false);
  });

  it('keeps the "." rule for users: a ":" grant stays literal', async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('poster', 'posts:*');
    await store.assignRole({ type: 'user', id: '1' }, 'poster');
    expect(await service.can({ id: '1' }, 'posts:edit')).toBe(false);
  });

  it("lists the caller's capabilities among its effective permissions", async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('exporter', 'reports.export');
    await store.assignRole(appSubjectRef('agora-hub'), 'exporter');
    expect((await service.effectivePermissions(hub)).sort()).toEqual([
      'media:objects:read',
      'payments:*',
      'reports.export',
    ]);
  });

  it("reads the request's caller for a bare app ref (async local storage)", async () => {
    const { service } = makeService();
    vi.spyOn(HttpContext, 'get').mockReturnValue({ agora: { caller: hub } } as never);
    expect(await service.can(appSubjectRef('agora-hub'), 'media:objects:read')).toBe(true);
    expect(await service.can(appSubjectRef('cms'), 'media:objects:read')).toBe(false);
  });

  it('hands the app ref to the superAdmin hook', async () => {
    const seen: unknown[] = [];
    const { service } = makeService({
      superAdmin: (ref) => {
        seen.push(ref);
        return ref.type === 'app' && ref.id === 'root' ? true : undefined;
      },
    });
    expect(await service.can({ app: 'root' }, 'anything')).toBe(true);
    expect(seen).toEqual([{ type: 'app', id: 'root' }]);
  });

  it('scopes an app by its capabilities and ":" grants', async () => {
    const { store, service } = makeService();
    expect((await service.scope(hub, 'media', { action: 'media:objects:read' })).kind).toBe('all');
    await store.givePermissionToRole('media-reader', 'media:*');
    await store.assignRole(appSubjectRef('cms'), 'media-reader');
    expect(
      (await service.scope(appSubjectRef('cms'), 'media', { action: 'media:objects:read' })).kind,
    ).toBe('all');
  });

  it('explains an app decision by its token capabilities and ":" grants', async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('media-reader', 'media:*');
    await store.assignRole(appSubjectRef('agora-hub'), 'media-reader');
    const explained = await service.explainCheck(appSubjectRef('agora-hub'), 'media:objects:read', {
      user: hub,
    });
    expect(explained.allowed).toBe(true);
    expect(explained.tokenCapabilities).toEqual(['media:objects:read']);
    expect(explained.grantingRoles).toEqual([{ role: 'media-reader', matched: ['media:*'] }]);
  });

  it('reads ctx.agora.caller', () => {
    expect(appCallerOf({ agora: { caller: hub } })).toBe(hub);
    expect(appCallerOf({ agora: {} })).toBeUndefined();
    expect(appCallerOf(undefined)).toBeUndefined();
  });

  it('applies the Agora capability rule', () => {
    expect(capabilityAllows('*', 'a:b')).toBe(true);
    expect(capabilityAllows('a:*', 'a')).toBe(true);
    expect(capabilityAllows('a:*:c', 'a:b:c')).toBe(true);
    expect(capabilityAllows('a:*:c', 'a:c')).toBe(false);
    expect(capabilityAllows('a:b', 'a:b:c')).toBe(false);
  });
});

describe('permitAuthz', () => {
  let service: AuthzService;
  let store: MemoryPermissionStore;

  beforeEach(() => {
    ({ service, store } = makeService());
    makeSpy.mockReset();
    makeSpy.mockResolvedValue(service);
  });

  it('permits by the capabilities a seam hands over in claims', async () => {
    const permit = permitAuthz();
    const caller = { app: 'agora-hub', claims: { capabilities: ['media:objects:*'] } };
    expect(await permit(caller, 'media:objects:write')).toBe(true);
    expect(await permit(caller, 'payments:charges:read')).toBe(false);
  });

  it('permits an app identified without authkit by its grants in the store', async () => {
    await store.givePermissionToRole('reader', 'media:objects:read');
    await store.assignRole(appSubjectRef('hub'), 'reader');
    const permit = permitAuthz();
    expect(await permit({ app: 'hub' }, 'media:objects:read')).toBe(true);
    expect(await permit({ app: 'hub' }, 'media:objects:write')).toBe(false);
  });

  it('refuses a caller without a name', async () => {
    expect(await permitAuthz()({ app: '' }, 'media:objects:read')).toBe(false);
  });
});

describe('requireRole with appCallers', () => {
  function ctxWith(caller: unknown, user?: unknown) {
    const calls: { forbidden?: unknown; unauthorized?: unknown } = {};
    const ctx = {
      agora: { caller },
      auth: { user, authenticationAttempted: true },
      response: {
        forbidden: (body?: unknown) => {
          calls.forbidden = body ?? true;
        },
        unauthorized: (body?: unknown) => {
          calls.unauthorized = body ?? true;
        },
      },
    };
    return { ctx: ctx as never, calls };
  }

  it("opens the route by the caller's permissions", async () => {
    const { service } = makeService();
    const mw = new AuthzRoleMiddleware(service);
    const { ctx } = ctxWith(hub);
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { permissions: ['media:objects:read'], appCallers: true },
    );
    expect(nexted).toBe(true);
  });

  it("opens the route by the caller's roles in authz", async () => {
    const { store, service } = makeService();
    await store.assignRole(appSubjectRef('agora-hub'), 'integrator');
    const mw = new AuthzRoleMiddleware(service);
    const { ctx } = ctxWith(hub);
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['integrator'], appCallers: true },
    );
    expect(nexted).toBe(true);
  });

  it('answers 403 to a caller without the permission', async () => {
    const { service } = makeService();
    const mw = new AuthzRoleMiddleware(service);
    const { ctx, calls } = ctxWith(hub);
    await mw.handle(ctx, (async () => {}) as never, {
      permissions: ['media:objects:write'],
      appCallers: true,
    });
    expect(calls.forbidden).toEqual({ message: 'Forbidden' });
  });

  it('checks a signed-in user as the user, even with a caller', async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('exporter', 'reports.export');
    await store.assignRole({ type: 'user', id: '1' }, 'exporter');
    const mw = new AuthzRoleMiddleware(service);
    const { ctx } = ctxWith(hub, { id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { permissions: ['reports.export'], appCallers: true },
    );
    expect(nexted).toBe(true);
  });

  it('opens a route wildcard for a caller holding a permission under it', async () => {
    const { store, service } = makeService();
    await store.givePermissionToRole('exporter', 'reports.export');
    await store.assignRole(appSubjectRef('agora-hub'), 'exporter');
    const mw = new AuthzRoleMiddleware(service);
    for (const route of ['reports.*', 'media:*']) {
      const { ctx } = ctxWith(hub);
      let nexted = false;
      await mw.handle(
        ctx,
        (async () => {
          nexted = true;
        }) as never,
        { permissions: [route], appCallers: true },
      );
      expect(nexted, route).toBe(true);
    }
    const { ctx, calls } = ctxWith(hub);
    await mw.handle(ctx, (async () => {}) as never, {
      permissions: ['billing.*'],
      appCallers: true,
    });
    expect(calls.forbidden).toEqual({ message: 'Forbidden' });
  });

  it('ignores the caller unless appCallers is on (401)', async () => {
    const { service } = makeService();
    const mw = new AuthzRoleMiddleware(service);
    const { ctx, calls } = ctxWith(hub);
    await mw.handle(ctx, (async () => {}) as never, { permissions: ['media:objects:read'] });
    expect(calls.unauthorized).toEqual({ message: 'Unauthenticated' });
  });
});
