import { afterEach, describe, expect, it } from 'vitest';
import AuthzProvider from '../providers/authz_provider.js';
import { AGORA_CONTEXT_TENANCY } from '../src/agora/tenancy.js';
import { AuthzService } from '../src/authz_service.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from '../src/doctor/agora_doctor.js';
import { authzDoctorChecks } from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

type Slots = Record<symbol, unknown>;

afterEach(() => {
  delete (globalThis as Slots)[AGORA_CONTEXT_TENANCY];
});

function fakeApp(authz: unknown, opts: { inProduction?: boolean; context?: unknown } = {}) {
  const store = new MemoryPermissionStore();
  const service = new AuthzService({ store });
  return {
    store,
    app: {
      inProduction: opts.inProduction ?? false,
      config: {
        get: (key: string, fallback: unknown) => {
          if (key === 'authz') return authz;
          if (key === 'context.tenancy.enabled')
            return (opts.context as { enabled?: boolean } | undefined)?.enabled ?? fallback;
          return fallback;
        },
      },
      container: { make: async () => service },
    } as never,
  };
}

const byId = (id: string) => authzDoctorChecks().find((c) => c.id === id) as AgoraDoctorCheck;

async function run(id: string, app: never): Promise<AgoraDoctorResult[]> {
  const out = await byId(id).run(app);
  return Array.isArray(out) ? out : [out];
}

const stores = { mem: async () => new MemoryPermissionStore() };

describe('authz doctor checks', () => {
  it('have frozen ids, all under the authz lib, exported for --no-boot', () => {
    expect(authzDoctorChecks().map((c) => [c.id, c.cost ?? 'cheap'])).toEqual([
      ['authz.config', 'cheap'],
      ['authz.super-admin', 'cheap'],
      ['authz.tenancy', 'cheap'],
      ['authz.store-reachable', 'deep'],
      ['authz.catalog-sync', 'deep'],
    ]);
    expect(authzDoctorChecks().every((c) => c.lib === 'authz')).toBe(true);
    expect(agoraDoctorChecks.map((c) => c.id)).toContain('authz.catalog-sync');
  });

  it('authz.config: errors on no store and an unknown default', async () => {
    expect((await run('authz.config', fakeApp({}).app))[0]?.status).toBe('error');
    const unknown = await run('authz.config', fakeApp({ stores, default: 'lucid' }).app);
    expect(unknown[0]).toMatchObject({ status: 'error', fix: 'Set default to one of: mem' });
    expect((await run('authz.config', fakeApp({ stores }).app))[0]?.status).toBe('ok');
  });

  it('authz.super-admin: lists the bypasses', async () => {
    const none = await run('authz.super-admin', fakeApp({ stores }).app);
    expect(none[0]?.message).toBe('no super-admin bypass configured');
    const set = await run(
      'authz.super-admin',
      fakeApp({ stores, superAdminRoles: ['ROOT'] }, { inProduction: true }).app,
    );
    expect(set[0]).toMatchObject({
      status: 'ok',
      message: 'superAdminRoles: ROOT allow everything in production',
    });
  });

  describe('authz.tenancy', () => {
    it('skips while tenancy is off, warns when roles are mapped anyway', async () => {
      expect((await run('authz.tenancy', fakeApp({ stores }).app))[0]?.status).toBe('skip');
      const mapped = await run(
        'authz.tenancy',
        fakeApp({ stores, tenancy: { roles: { owner: 'org_admin' } } }).app,
      );
      expect(mapped[0]?.status).toBe('warn');
    });

    it('reads tenancy from the context slot, or config/context.ts without it', async () => {
      const viaConfig = await run(
        'authz.tenancy',
        fakeApp({ stores }, { context: { enabled: true } }).app,
      );
      expect(viaConfig[0]).toMatchObject({ status: 'ok' });
      (globalThis as Slots)[AGORA_CONTEXT_TENANCY] = {
        version: 1,
        tenancy: () => ({ enabled: true }),
        tenantFilter: () => ({ mode: 'system' }),
      };
      const viaSlot = await run('authz.tenancy', fakeApp({ stores }).app);
      expect(viaSlot[0]?.message).toBe('checks default to the active tenant');
      const optedOut = await run('authz.tenancy', fakeApp({ stores, tenancy: false }).app);
      expect(optedOut[0]?.status).toBe('skip');
    });

    it('warns for mapped roles with no roleGrants', async () => {
      const out = await run(
        'authz.tenancy',
        fakeApp(
          {
            stores,
            tenancy: { enabled: true, roles: { owner: 'org_admin', member: ['org_member'] } },
            roleGrants: { org_admin: ['*'] },
          },
          {},
        ).app,
      );
      expect(out.map((r) => r.status)).toEqual(['ok', 'warn']);
      expect(out[1]?.message).toContain('org_member');
    });
  });

  describe('authz.catalog-sync (deep)', () => {
    it('skips without a catalog', async () => {
      expect((await run('authz.catalog-sync', fakeApp({ stores }).app))[0]?.status).toBe('skip');
    });

    it('warns until authz:sync ran, then is ok', async () => {
      const catalog = { permissions: ['a.b'], roles: { editor: ['posts.edit'] } };
      const { app, store } = fakeApp({ stores, catalog });
      const before = await run('authz.catalog-sync', app);
      expect(before[0]).toMatchObject({ status: 'warn', fix: 'Run `node ace authz:sync`' });
      expect(before[0]?.message).toContain('roles editor');

      await store.createPermission('a.b');
      await store.createRole('editor');
      const partial = await run('authz.catalog-sync', app);
      expect(partial[0]?.message).toContain('1 role grant(s)');

      await store.givePermissionToRole('editor', 'posts.edit');
      expect((await run('authz.catalog-sync', app))[0]?.status).toBe('ok');
    });
  });

  it('authz.store-reachable (deep): counts roles', async () => {
    const { app, store } = fakeApp({ stores });
    await store.createRole('x');
    expect((await run('authz.store-reachable', app))[0]).toMatchObject({
      status: 'ok',
      message: '1 role(s) in the store',
    });
  });

  it('the provider registers the checks into agora.doctor from boot()', async () => {
    const values = new Map<string, unknown>();
    const app = {
      config: { get: (_k: string, d: unknown) => (_k === 'authz' ? { stores } : d) },
      container: {
        singleton: () => {},
        hasBinding: (key: string) => values.has(key),
        bindValue: (key: string, value: unknown) => values.set(key, value),
        make: async (key: string) => values.get(key),
      },
    };
    const provider = new AuthzProvider(app as never);
    provider.register();
    await provider.boot();
    const registry = values.get('agora.doctor') as { version: number; checks: AgoraDoctorCheck[] };
    expect(registry.version).toBe(1);
    expect(registry.checks.map((c) => c.id)).toContain('authz.catalog-sync');
    await provider.boot();
    expect(registry.checks.filter((c) => c.id === 'authz.config')).toHaveLength(1);
  });
});
