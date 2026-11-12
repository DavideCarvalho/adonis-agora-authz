import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGORA_CONTEXT_ACCESSOR } from '../src/agora/context.js';
import { AGORA_CONTEXT_TENANCY, type TenantFilter } from '../src/agora/tenancy.js';
import { AuthzService, type AuthzServiceOptions } from '../src/authz_service.js';
import type { DevTool, DevToolCall, DevToolsHub, DevToolsLib } from '../src/dev_tools/contract.js';
import {
  type AuthzDevToolsOptions,
  authzDevTools,
  pageOf,
  registerAuthzDevTools,
} from '../src/dev_tools/tools.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

type Slots = Record<symbol, unknown>;

const call: DevToolCall = {
  ctx: {},
  caller: { id: 'token:3f9a1c2b7d10', via: 'token' },
  limits: { maxRows: 100, maxBytes: 48_000 },
};

afterEach(() => {
  delete (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR];
  delete (globalThis as Slots)[AGORA_CONTEXT_TENANCY];
});

function activeTenant(id: string, callerId?: string, role?: string) {
  const store = callerId ? { userRef: { type: 'user', id: callerId } } : {};
  (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR] = { get: () => store };
  (globalThis as Slots)[AGORA_CONTEXT_TENANCY] = {
    version: 1,
    tenancy: () => ({ enabled: true }),
    tenantFilter: (): TenantFilter => ({
      mode: 'tenant',
      tenant: { id, kind: 'organization', source: 'authkit', ...(role ? { role } : {}) },
    }),
  };
}

async function setup(
  extra: Partial<AuthzServiceOptions> = {},
  devOptions: AuthzDevToolsOptions = {},
  catalog?: Record<string, string[]>,
) {
  const store = new MemoryPermissionStore();
  await store.assignRole({ type: 'user', id: 'ana' }, 'editor');
  await store.givePermissionToRole('editor', 'posts.*');
  await store.assignRole({ type: 'user', id: 'ana' }, 'billing', { tenantId: 'acme' });
  await store.givePermissionToRole('billing', 'invoices.read');
  await store.givePermissionToRole('auditor', 'audit.read');
  const roleGrants = { support: ['tickets.*'], org_admin: ['members.*'] };
  const service = new AuthzService({ store, roleGrants, ...extra });
  const tools = authzDevTools({
    service: async () => service,
    roleGrants: () => roleGrants,
    catalog: () => (catalog ? { roles: catalog } : undefined),
    options: () => devOptions,
  });
  const tool = (name: string) => tools.find((t) => t.name === name) as DevTool;
  return { store, service, tools, tool };
}

describe('authz dev tools', () => {
  it('are all read tools that follow the hub naming rules and the input subset', async () => {
    const { tools } = await setup();
    expect(tools.map((t) => [t.name, t.kind])).toEqual([
      ['authz_explain_check', 'read'],
      ['authz_list_effective_roles', 'read'],
      ['authz_list_effective_permissions', 'read'],
      ['authz_list_roles', 'read'],
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^authz_[a-z0-9]+(_[a-z0-9]+)+$/);
      expect(t.input.type).toBe('object');
      for (const prop of Object.values(t.input.properties)) {
        expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(prop.type);
      }
      for (const name of t.input.required ?? []) expect(t.input.properties).toHaveProperty(name);
    }
  });

  describe('authz_explain_check', () => {
    it('explains an allow by a store role', async () => {
      const { tool } = await setup();
      const out = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'posts.edit' },
        call,
      )) as Record<string, unknown>;
      expect(out).toMatchObject({
        allowed: true,
        reason: 'permission',
        superAdmin: false,
        decisionProvider: 'none',
        subject: { type: 'user', id: 'ana' },
        tenant: { id: null, from: 'global' },
        effectiveRoles: ['editor'],
        grantingRoles: [{ role: 'editor', matched: ['posts.*'] }],
        directGrants: [],
        subjectLoaded: false,
      });
    });

    it('explains a deny with no grant, and an anonymous-free unknown subject', async () => {
      const { tool } = await setup();
      const out = (await tool('authz_explain_check').run(
        { subjectId: 'zed', permission: 'posts.edit' },
        call,
      )) as Record<string, unknown>;
      expect(out).toMatchObject({ allowed: false, reason: 'no-grant', effectiveRoles: [] });
    });

    it('checks in an explicit tenant, or the active tenant by default', async () => {
      const { tool } = await setup();
      const explicit = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'invoices.read', tenantId: 'acme' },
        call,
      )) as Record<string, unknown>;
      expect(explicit).toMatchObject({ allowed: true, tenant: { id: 'acme', from: 'explicit' } });

      activeTenant('acme');
      const fromContext = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'invoices.read' },
        call,
      )) as Record<string, unknown>;
      expect(fromContext).toMatchObject({ allowed: true, tenant: { id: 'acme', from: 'default' } });

      const global = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'invoices.read', tenantId: '' },
        call,
      )) as Record<string, unknown>;
      expect(global).toMatchObject({ allowed: false, tenant: { id: null, from: 'global' } });
    });

    it('shows roles mapped from the caller org role (tenancy.roles)', async () => {
      const { tool } = await setup({ tenancy: { roles: { owner: 'org_admin' } } });
      activeTenant('acme', 'bob', 'owner');
      const out = (await tool('authz_explain_check').run(
        { subjectId: 'bob', permission: 'members.invite' },
        call,
      )) as { allowed: boolean; roleSources: { tenant: string[] }; grantingRoles: unknown };
      expect(out.allowed).toBe(true);
      expect(out.roleSources.tenant).toEqual(['org_admin']);
      expect(out.grantingRoles).toEqual([{ role: 'org_admin', matched: ['members.*'] }]);
    });

    it('reports the super-admin hook and hands the loaded subject and resource to the hooks', async () => {
      const superAdmin = vi.fn((ref: { id: string }) => (ref.id === 'root' ? true : undefined));
      const decide = vi.fn(() => undefined);
      const loadSubject = vi.fn(async (ref: { id: string }) => ({ ...ref, model: 'User' }));
      const loadResource = vi.fn(async (ref: { id: string }) => ({ kind: 'post', ...ref }));
      const { tool } = await setup(
        { superAdmin, decisionProvider: { decide } },
        { loadSubject, loadResource },
      );
      const root = (await tool('authz_explain_check').run(
        { subjectId: 'root', permission: 'x.y', resourceType: 'post', resourceId: '7' },
        call,
      )) as Record<string, unknown>;
      expect(root).toMatchObject({
        allowed: true,
        reason: 'super-admin',
        superAdmin: true,
        decisionProvider: 'not-consulted',
        subjectLoaded: true,
        resourceLoaded: true,
      });
      expect(superAdmin).toHaveBeenCalledWith({ type: 'user', id: 'root' }, 'x.y', {
        kind: 'post',
        type: 'post',
        id: '7',
      });

      await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'x.y', resourceType: 'post', resourceId: '7' },
        call,
      );
      expect(decide).toHaveBeenCalledWith(
        { type: 'user', id: 'ana', model: 'User' },
        'x.y',
        { kind: 'post', type: 'post', id: '7' },
        expect.anything(),
      );
    });

    it('hands hooks the refs when there is nothing to load', async () => {
      const decide = vi.fn(() => undefined);
      const { tool } = await setup({ decisionProvider: { decide } });
      const out = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'x.y', resourceType: 'post', resourceId: '7' },
        call,
      )) as Record<string, unknown>;
      expect(out).toMatchObject({ subjectLoaded: false, resourceLoaded: false });
      expect(decide).toHaveBeenCalledWith(
        { type: 'user', id: 'ana' },
        'x.y',
        { type: 'post', id: '7' },
        expect.anything(),
      );
    });

    it('reports what the decision provider said', async () => {
      const decide = vi.fn((_user: unknown, ability: string) =>
        ability === 'deny.me' ? { allowed: false, message: 'policy says no' } : undefined,
      );
      const { tool } = await setup({ decisionProvider: { decide } });
      const denied = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'deny.me' },
        call,
      )) as Record<string, unknown>;
      expect(denied).toMatchObject({
        allowed: false,
        reason: 'decision-provider',
        message: 'policy says no',
        decisionProvider: 'denied',
      });
      const abstained = (await tool('authz_explain_check').run(
        { subjectId: 'ana', permission: 'posts.read' },
        call,
      )) as Record<string, unknown>;
      expect(abstained).toMatchObject({ allowed: true, decisionProvider: 'abstained' });
    });

    it('requires subjectId and permission', async () => {
      const { tool } = await setup();
      await expect(tool('authz_explain_check').run({ permission: 'a' }, call)).rejects.toThrow(
        /subjectId/,
      );
      await expect(tool('authz_explain_check').run({ subjectId: 'ana' }, call)).rejects.toThrow(
        /permission/,
      );
    });
  });

  it('authz_list_effective_roles lists each role with its sources', async () => {
    const resolveRoles = () => ['editor', 'support'];
    const { tool } = await setup({ resolveRoles });
    const out = (await tool('authz_list_effective_roles').run(
      { subjectId: 'ana', tenantId: 'acme' },
      call,
    )) as { items: unknown[]; tenant: unknown };
    expect(out.tenant).toEqual({ id: 'acme', from: 'explicit' });
    expect(out.items).toEqual([
      { role: 'editor', sources: ['app', 'store'] },
      { role: 'support', sources: ['app'] },
      { role: 'billing', sources: ['store'] },
    ]);
  });

  it('authz_list_effective_permissions pages the sorted permissions', async () => {
    const { tool } = await setup({ resolveRoles: () => ['support'] });
    const out = (await tool('authz_list_effective_permissions').run(
      { subjectId: 'ana', limit: 1 },
      call,
    )) as { items: string[]; next: number | null };
    expect(out.items).toEqual(['posts.*']);
    expect(out.next).toBe(2);
    const second = (await tool('authz_list_effective_permissions').run(
      { subjectId: 'ana', limit: 1, page: 2 },
      call,
    )) as { items: string[]; next: number | null };
    expect(second).toMatchObject({ items: ['tickets.*'], next: null });
  });

  it('authz_list_roles merges store, roleGrants and catalog, and flags drift', async () => {
    const { tool } = await setup({}, {}, { editor: ['posts.*', 'posts.publish'], newbie: ['a.b'] });
    const out = (await tool('authz_list_roles').run({}, call)) as {
      items: Array<Record<string, unknown>>;
    };
    const byRole = Object.fromEntries(out.items.map((r) => [r.role, r]));
    expect(byRole.editor).toMatchObject({
      inStore: true,
      permissions: ['posts.*'],
      catalog: ['posts.*', 'posts.publish'],
      missingInStore: ['posts.publish'],
      drift: true,
    });
    expect(byRole.newbie).toMatchObject({ inStore: false, drift: true });
    expect(byRole.support).toMatchObject({
      inStore: false,
      roleGrants: ['tickets.*'],
      drift: false,
    });
    expect(byRole.auditor).toMatchObject({ inStore: true, catalog: null, drift: false });

    const drifted = (await tool('authz_list_roles').run({ drift: true }, call)) as {
      items: Array<{ role: string }>;
    };
    expect(drifted.items.map((r) => r.role)).toEqual(['editor', 'newbie']);
  });

  it('pageOf clamps limit and page', () => {
    expect(pageOf([1, 2, 3], { limit: 500 })).toEqual({ items: [1, 2, 3], next: null });
    expect(pageOf([1, 2, 3], { limit: 2, page: 0 })).toEqual({ items: [1, 2], next: 2 });
  });
});

describe('registerAuthzDevTools', () => {
  const deps = { service: async () => new AuthzService({ store: new MemoryPermissionStore() }) };

  function container(hub: unknown) {
    return {
      hasBinding: (key: string) => key === 'agora.devTools' && hub !== undefined,
      make: async () => hub,
    };
  }

  it('registers without authorize on a hub that supports endpoint-authorize', async () => {
    const registered: DevToolsLib[] = [];
    const hub: DevToolsHub = {
      version: 1,
      register: (lib) => registered.push(lib),
      supports: (f) => f === 'endpoint-authorize',
    };
    expect(await registerAuthzDevTools(container(hub), deps)).toBe('registered');
    expect(registered[0]?.lib).toBe('authz');
    expect(registered[0]?.authorize).toBeUndefined();
    expect(registered[0]?.tools).toHaveLength(4);
  });

  it('skips without a hub, on an old hub, and never throws', async () => {
    expect(await registerAuthzDevTools(container(undefined), deps)).toBe('no-hub');
    const old = { version: 1, register: vi.fn() };
    expect(await registerAuthzDevTools(container(old), deps)).toBe('unsupported');
    expect(old.register).not.toHaveBeenCalled();
    expect(await registerAuthzDevTools(container({ version: 2 }), deps)).toBe('unsupported');
    const throwing = {
      version: 1,
      supports: () => true,
      register: () => {
        throw new Error('duplicate');
      },
    };
    expect(await registerAuthzDevTools(container(throwing), deps)).toBe('failed');
  });
});

describe('authz_explain_check input', () => {
  it('refuses half a resource', async () => {
    const service = new AuthzService({ store: new MemoryPermissionStore() });
    const [explain] = authzDevTools({ service: async () => service });
    await expect(
      (explain as DevTool).run({ subjectId: 'a', permission: 'x', resourceType: 'post' }, call),
    ).rejects.toThrow(/go together/);
  });

  it('runs the super-admin hook once per explanation', async () => {
    const superAdmin = vi.fn(() => true);
    const service = new AuthzService({ store: new MemoryPermissionStore(), superAdmin });
    const out = await service.explainCheck({ type: 'user', id: 'a' }, 'x');
    expect(out).toMatchObject({ allowed: true, superAdmin: true });
    expect(superAdmin).toHaveBeenCalledTimes(1);
  });
});
