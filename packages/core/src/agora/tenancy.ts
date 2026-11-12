/**
 * Structural reader for the tenancy contract `@adonis-agora/context` publishes on
 * `globalThis[Symbol.for('@agora/context:tenancy')]` (version 1). authz never imports that
 * package: with the slot missing, too old, or throwing, tenancy reads as OFF and authz behaves
 * exactly as it does without it.
 *
 * "Tenant" here is the customer the request acts for (an organization, a clinic, …), never a
 * process topology.
 */

/** The global slot context publishes its tenancy contract on. */
export const AGORA_CONTEXT_TENANCY = Symbol.for('@agora/context:tenancy');

/** One level of a tenant chain (e.g. a clinic, or a unit inside it). */
export interface TenantLevel {
  id: string;
  kind: string;
  slug?: string;
  /** The caller's role inside this tenant (authkit `orgRole`). */
  role?: string;
}

/** The active tenant, as context publishes it. */
export interface TenantRef extends TenantLevel {
  source: string;
  chain?: TenantLevel[];
  family?: string;
}

/** How a read must be scoped right now (context's `tenantFilter()`). */
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantRef; chain?: TenantLevel[] };

interface TenancySlot {
  version?: number;
  tenancy?: () => { enabled?: boolean; kinds?: string[] } | undefined;
  tenantFilter?: (options?: {
    kinds?: string[];
    family?: string;
    required?: boolean;
  }) => TenantFilter;
}

/**
 * The `tenancy` option of `config/authz.ts`.
 *
 * - `'inherit'` (default): follow `tenancy.enabled` in `config/context.ts`.
 * - `false`: never read the context tenant, even when context enables tenancy.
 * - an object: fine-tune it (see the fields).
 */
export type AuthzTenancyOption =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `config/context.ts`; a boolean forces it. */
      enabled?: 'inherit' | boolean;
      /**
       * Tenant kinds authz honours (`['organization']`, `['clinic']`…). With nested tenants the
       * innermost level of one of these kinds is used. Default: context's `tenancy.kinds`.
       */
      kinds?: string[];
      /** Only use the tenant of this family (when a request carries more than one). */
      family?: string;
      /**
       * Map the caller's role inside the active tenant (authkit `orgRole`, or the `role` an app
       * passes to `Context.setTenant`) to authz roles, in that tenant's scope only.
       * `{ owner: 'org_admin', member: 'org_member' }`. Unmapped roles grant nothing.
       */
      roles?: Record<string, string | string[]>;
    };

/** {@link AuthzTenancyOption} resolved against context. */
export interface ResolvedAuthzTenancy {
  enabled: boolean;
  kinds?: string[];
  family?: string;
  roles?: Record<string, string | string[]>;
}

function slot(): TenancySlot | undefined {
  const value = (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_TENANCY];
  if (value === null || typeof value !== 'object') return undefined;
  const tenancy = value as TenancySlot;
  return tenancy.version === 1 && typeof tenancy.tenantFilter === 'function' ? tenancy : undefined;
}

/** Whether context's tenancy slot (version 1) is published in this process. */
export function hasTenancySlot(): boolean {
  return slot() !== undefined;
}

/**
 * Resolve authz's `tenancy` option. With no (or an old) context, or `false`, tenancy is off.
 * Read per call: it is two property reads, and it follows context's config even when the authz
 * service was built before context booted.
 */
export function resolveAuthzTenancy(option: AuthzTenancyOption | undefined): ResolvedAuthzTenancy {
  if (option === false) return { enabled: false };
  const tenancy = slot();
  if (tenancy === undefined) return { enabled: false };
  const own = typeof option === 'object' && option !== null ? option : {};
  let context: { enabled?: boolean; kinds?: string[] } | undefined;
  try {
    context = tenancy.tenancy?.();
  } catch {
    context = undefined;
  }
  const enabled =
    own.enabled === undefined || own.enabled === 'inherit'
      ? context?.enabled === true
      : own.enabled;
  const kinds = own.kinds ?? context?.kinds;
  return {
    enabled,
    ...(kinds !== undefined ? { kinds: [...kinds] } : {}),
    ...(own.family !== undefined ? { family: own.family } : {}),
    ...(own.roles !== undefined ? { roles: own.roles } : {}),
  };
}

/**
 * The active tenant for authz, or `undefined` (tenancy off, no tenant, a tenant of a kind authz
 * does not honour, inside `Context.allTenants()`, or outside a request). Never throws: authz does
 * not need a tenant (a check without one runs in the global scope), so context's `required` does
 * not apply here.
 */
export function contextTenant(
  tenancy: ResolvedAuthzTenancy,
): { tenant: TenantRef; chain: TenantLevel[] } | undefined {
  if (!tenancy.enabled) return undefined;
  const reader = slot();
  if (reader === undefined) return undefined;
  let filter: TenantFilter | undefined;
  try {
    filter = reader.tenantFilter?.({
      ...(tenancy.kinds !== undefined ? { kinds: tenancy.kinds } : {}),
      ...(tenancy.family !== undefined ? { family: tenancy.family } : {}),
      required: false,
    });
  } catch {
    return undefined;
  }
  if (filter === undefined || filter === null || filter.mode !== 'tenant') return undefined;
  const tenant = filter.tenant;
  if (tenant === undefined || typeof tenant.id !== 'string' || tenant.id === '') return undefined;
  if (tenancy.kinds !== undefined && !tenancy.kinds.includes(tenant.kind)) return undefined;
  const chain = Array.isArray(filter.chain) && filter.chain.length > 0 ? filter.chain : [tenant];
  return { tenant, chain };
}

/**
 * The authz roles the caller holds through its role inside the tenant `tenantId`, per
 * `tenancy.roles`. Looks at every level of the active chain, so a check scoped to a parent level
 * (the clinic of a unit) maps the caller's role in that level.
 */
export function mappedTenantRoles(
  tenancy: ResolvedAuthzTenancy,
  tenantId: string | undefined,
): string[] {
  if (!tenancy.enabled || tenancy.roles === undefined || !tenantId) return [];
  const active = contextTenant(tenancy);
  if (active === undefined) return [];
  const roles: string[] = [];
  for (const level of active.chain) {
    if (level.id !== tenantId || typeof level.role !== 'string') continue;
    const mapped = Object.hasOwn(tenancy.roles, level.role) ? tenancy.roles[level.role] : undefined;
    if (mapped === undefined) continue;
    roles.push(...(typeof mapped === 'string' ? [mapped] : mapped));
  }
  return [...new Set(roles)];
}
