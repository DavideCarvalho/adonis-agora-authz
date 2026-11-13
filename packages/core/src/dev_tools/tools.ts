import type { AuthzService } from '../authz_service.js';
import type { AuthzCatalog } from '../define_config.js';
import { normalizeSubjectRef, type SubjectRef, type TenantScope } from '../subject_ref.js';
import type { DevTool, DevToolInputProperty, DevToolsHub } from './contract.js';
import { DEV_TOOLS_BINDING } from './contract.js';

/**
 * Hooks of `devTools` in `config/authz.ts`: load the real models behind refs, so the decision
 * provider and the `superAdmin` hook see what they see in the app.
 */
export interface AuthzDevToolsOptions {
  /**
   * Load the subject a tool asks about (`{ type: 'user', id: '42' }` → your `User`), so the
   * decision provider and `resolveSubjectRef` see your model, as they do in the app. Without it
   * they receive the `{ type, id }` ref. Return `undefined`/`null` when it does not exist.
   */
  loadSubject?: (ref: SubjectRef) => unknown | Promise<unknown>;
  /**
   * Load the resource of `authz_explain_check` (`{ type: 'post', id: '7' }` → your `Post`) for
   * the `superAdmin` hook and the decision provider. Without it they receive the `{ type, id }` ref.
   */
  loadResource?: (ref: { type: string; id: string }) => unknown | Promise<unknown>;
}

/** What `authz_list_roles` needs besides the service. */
export interface AuthzDevToolsDeps {
  service: () => Promise<AuthzService>;
  catalog?: () => AuthzCatalog | undefined;
  roleGrants?: () => Record<string, string[]> | undefined;
  options?: () => AuthzDevToolsOptions;
}

const subjectType: DevToolInputProperty = {
  type: 'string',
  description: "The subject type (default 'user').",
};
const subjectId: DevToolInputProperty = {
  type: 'string',
  description: 'The subject id (a user id, a team id…).',
};
const tenantId: DevToolInputProperty = {
  type: 'string',
  description:
    "Tenant to check in. Omitted: the request's active tenant when tenancy is on, else global. '' forces the global scope.",
};
const limit: DevToolInputProperty = {
  type: 'integer',
  description: 'How many items to return (default 20, max 100).',
  minimum: 1,
  maximum: 100,
};
const page: DevToolInputProperty = {
  type: 'integer',
  description: 'Page number, from 1 (the `next` of the previous answer).',
  minimum: 1,
};

function intOf(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** One page of `items` in the `{ items, next }` shape every dev-tools list returns. */
export function pageOf<T>(items: readonly T[], input: Record<string, unknown>) {
  const size = intOf(input.limit, 20, 100);
  const number = intOf(input.page, 1);
  const start = (number - 1) * size;
  return {
    items: items.slice(start, start + size),
    next: start + size < items.length ? number + 1 : null,
  };
}

function subjectOf(input: Record<string, unknown>): SubjectRef {
  const id = str(input.subjectId);
  if (id === undefined) throw new Error('`subjectId` is required');
  return normalizeSubjectRef({ type: str(input.subjectType) ?? 'user', id });
}

/** `tenantId` input → explicit scope (`''` = global), or `undefined` to use the default. */
function scopeOf(input: Record<string, unknown>): TenantScope | undefined {
  if (typeof input.tenantId !== 'string') return undefined;
  const id = input.tenantId.trim();
  return { tenantId: id };
}

function scopeLabel(service: AuthzService, scope: TenantScope | undefined) {
  const resolved = service.currentScope(scope);
  const id = resolved?.tenantId ? resolved.tenantId : null;
  let from: 'explicit' | 'default' | 'global' = 'global';
  if (scope !== undefined) from = scope.tenantId ? 'explicit' : 'global';
  else if (id !== null) from = 'default';
  return { id, from };
}

async function load<T>(
  hook: ((ref: T) => unknown | Promise<unknown>) | undefined,
  ref: T,
): Promise<{ loaded: boolean; value: unknown }> {
  if (hook === undefined) return { loaded: false, value: undefined };
  const value = await hook(ref);
  return value === undefined || value === null
    ? { loaded: false, value: undefined }
    : { loaded: true, value };
}

const CALLER_NOTE =
  'Global roles from a token (authkit) and the role inside the active tenant only count for the user making the request; for another subject they are not visible here.';

/** One role as `authz_list_roles` and `authz:roles:list` show it. */
export interface AuthzRoleRow {
  role: string;
  inStore: boolean;
  permissions: string[];
  roleGrants: string[];
  catalog: string[] | null;
  missingInStore: string[];
  drift: boolean;
}

/**
 * The reads behind the authz dev tools, shared with the `authz:*` ace commands so both answer the
 * same thing. Inputs use the tool input names (`subjectType`, `subjectId`, `tenantId`, …).
 */
export function authzQueries(deps: AuthzDevToolsDeps) {
  const options = () => deps.options?.() ?? {};
  return {
    /** `authz_explain_check`: the verdict, its reason and what granted it. */
    async explainCheck(input: Record<string, unknown>) {
      const service = await deps.service();
      const ref = subjectOf(input);
      const permission = str(input.permission);
      if (permission === undefined) throw new Error('`permission` is required');
      const scope = scopeOf(input);
      const hooks = options();
      const subject = await load(hooks.loadSubject, ref);
      const resourceType = str(input.resourceType);
      const resourceId = str(input.resourceId);
      if ((resourceType === undefined) !== (resourceId === undefined)) {
        throw new Error('`resourceType` and `resourceId` go together: pass both or neither');
      }
      const resourceRef =
        resourceType !== undefined && resourceId !== undefined
          ? { type: resourceType, id: resourceId }
          : undefined;
      const resource = resourceRef ? await load(hooks.loadResource, resourceRef) : undefined;
      const explanation = await service.explainCheck(ref, permission, {
        ...(scope ? { scope } : {}),
        ...(subject.loaded ? { user: subject.value } : {}),
        ...(resourceRef ? { resource: resource?.loaded ? resource.value : resourceRef } : {}),
      });
      return {
        ...explanation,
        tenant: scopeLabel(service, scope),
        subjectLoaded: subject.loaded,
        ...(resourceRef ? { resourceLoaded: resource?.loaded === true } : {}),
        note: CALLER_NOTE,
      };
    },

    /** `authz_list_effective_roles`: each effective role with the sources it comes from. */
    async effectiveRoles(input: Record<string, unknown>) {
      const service = await deps.service();
      const ref = subjectOf(input);
      const scope = scopeOf(input);
      const tenant = service.currentScope(scope);
      const sources = await service.effectiveRoleSources(ref, tenant);
      const byRole = new Map<string, string[]>();
      for (const [source, roles] of Object.entries(sources)) {
        for (const role of roles) byRole.set(role, [...(byRole.get(role) ?? []), source]);
      }
      return {
        subject: ref,
        tenant: scopeLabel(service, scope),
        roles: [...byRole].map(([role, from]) => ({ role, sources: from })),
        note: CALLER_NOTE,
      };
    },

    /** `authz_list_effective_permissions`: every effective permission, sorted, unpaged. */
    async effectivePermissions(input: Record<string, unknown>) {
      const service = await deps.service();
      const ref = subjectOf(input);
      const scope = scopeOf(input);
      const subject = await load(options().loadSubject, ref);
      const permissions = await service.effectivePermissions(
        subject.loaded ? subject.value : ref,
        scope,
        { cache: service.createCache() },
      );
      return {
        subject: ref,
        tenant: scopeLabel(service, scope),
        permissions: [...permissions].sort(),
      };
    },

    /** `authz_list_roles`: every known role (store, roleGrants, catalog) with drift, unpaged. */
    async roles(input: Record<string, unknown>): Promise<AuthzRoleRow[]> {
      const service = await deps.service();
      const catalog = deps.catalog?.()?.roles ?? {};
      const grants = deps.roleGrants?.() ?? {};
      const stored = await service.store.listRoles();
      const only = str(input.role);
      const names = [...new Set([...stored, ...Object.keys(catalog), ...Object.keys(grants)])]
        .filter((name) => only === undefined || name === only)
        .sort();
      const storeSet = new Set(stored);
      const items: AuthzRoleRow[] = [];
      for (const role of names) {
        const inStore = storeSet.has(role);
        const storePermissions = inStore ? await service.store.getRolePermissions(role) : [];
        const declared = Object.hasOwn(catalog, role) ? (catalog[role] ?? []) : undefined;
        const missingInStore =
          declared === undefined ? [] : declared.filter((p) => !storePermissions.includes(p));
        const drift = declared !== undefined && (!inStore || missingInStore.length > 0);
        if (input.drift === true && !drift) continue;
        items.push({
          role,
          inStore,
          permissions: [...storePermissions].sort(),
          roleGrants: Object.hasOwn(grants, role) ? (grants[role] ?? []) : [],
          catalog: declared ?? null,
          missingInStore,
          drift,
        });
      }
      return items;
    },
  };
}

/**
 * The authz developer tools (all read-only): explain a check, a subject's effective roles and
 * permissions, and the role catalogue with store drift.
 */
export function authzDevTools(deps: AuthzDevToolsDeps): DevTool[] {
  const queries = authzQueries(deps);
  return [
    {
      name: 'authz_explain_check',
      kind: 'read',
      description:
        'Why a subject can or cannot do something: the verdict, its reason (super-admin, ' +
        'decision-provider, permission, anonymous, no-grant), what the decision provider said, the ' +
        "subject's effective roles with their sources, and which roles or direct grants cover the " +
        'permission. Read-only.',
      input: {
        type: 'object',
        properties: {
          subjectType,
          subjectId,
          permission: {
            type: 'string',
            description: "The permission or ability, e.g. 'posts.edit'.",
          },
          tenantId,
          resourceType: {
            type: 'string',
            description: 'Type of the resource the check is about (with resourceId).',
          },
          resourceId: { type: 'string', description: 'Id of the resource (with resourceType).' },
        },
        required: ['subjectId', 'permission'],
      },
      run: (input) => queries.explainCheck(input),
    },
    {
      name: 'authz_list_effective_roles',
      kind: 'read',
      description:
        "A subject's effective roles in a tenant, each with where it comes from: the token's " +
        'global roles (context), the role inside the active tenant (tenancy.roles), the app ' +
        '(resolveRoles) or the authz store.',
      input: {
        type: 'object',
        properties: { subjectType, subjectId, tenantId },
        required: ['subjectId'],
      },
      async run(input) {
        const { subject, tenant, roles, note } = await queries.effectiveRoles(input);
        return { subject, tenant, items: roles, next: null, note };
      },
    },
    {
      name: 'authz_list_effective_permissions',
      kind: 'read',
      description:
        "A subject's effective permissions in a tenant (store grants plus roleGrants of its " +
        'effective roles), wildcards as stored. Paged: { items, next }.',
      input: {
        type: 'object',
        properties: { subjectType, subjectId, tenantId, limit, page },
        required: ['subjectId'],
      },
      async run(input) {
        const { subject, tenant, permissions } = await queries.effectivePermissions(input);
        return { subject, tenant, ...pageOf(permissions, input) };
      },
    },
    {
      name: 'authz_list_roles',
      kind: 'read',
      description:
        'Every known role with its permissions in the store, in roleGrants and in the config ' +
        'catalog, and `drift` when catalog roles or grants are missing from the store (fix: node ace ' +
        'authz:sync). ' +
        'Paged: { items, next }.',
      input: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Only this role.' },
          drift: {
            type: 'boolean',
            description: 'Only catalog roles with something missing from the store.',
          },
          limit,
          page,
        },
      },
      async run(input) {
        return pageOf(await queries.roles(input), input);
      },
    },
  ];
}

/** The slice of the AdonisJS container {@link registerAuthzDevTools} uses. */
export interface DevToolsContainer {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/**
 * Register the authz tools into the dev-tools hub, when the agent's MCP provider bound one and it
 * can gate a lib without a console (`supports('endpoint-authorize')`). Never throws: returns why it
 * did not register.
 */
export async function registerAuthzDevTools(
  container: DevToolsContainer,
  deps: AuthzDevToolsDeps,
): Promise<'registered' | 'no-hub' | 'unsupported' | 'failed'> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return 'no-hub';
  try {
    const hub = (await container.make(DEV_TOOLS_BINDING)) as DevToolsHub | undefined;
    if (hub?.version !== 1) return 'unsupported';
    if (typeof hub.supports !== 'function' || !hub.supports('endpoint-authorize')) {
      return 'unsupported';
    }
    hub.register({ lib: 'authz', title: 'Authorization (authz)', tools: authzDevTools(deps) });
    return 'registered';
  } catch {
    return 'failed';
  }
}
