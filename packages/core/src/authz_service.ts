import { globalRolesFromContext } from './agora/context.js';
import { PermissionCache } from './permission_cache.js';
import { permissionSatisfied } from './permission_matcher.js';
import {
  normalizeScope,
  type ResourceKey,
  type ScopeConstraint,
  ScopeRegistry,
  scopeAll,
  scopeNone,
} from './scope.js';
import type { PermissionStore } from './store.js';
import {
  defaultResolveUserRef,
  normalizeUserRef,
  type ResolveUserRef,
  type TenantScope,
  type UserRef,
  type UserRefInput,
} from './user_ref.js';

export { tenantFromContext } from './agora/context.js';

/**
 * Super-admin hook (ported from nestjs-authz). Receives the mapped {@link UserRef}
 * and the ability/permission being checked.
 *
 * - `true`  → allow (short-circuit).
 * - `false` → deny (short-circuit). Super-admin is the only hook whose `false`
 *   actively denies.
 * - nullish → fall through to the normal RBAC resolution.
 */
export type SuperAdminHook = (
  user: UserRef,
  ability: string,
) => boolean | undefined | Promise<boolean | undefined>;

/** Reads the active tenant for the current request (e.g. from HTTP context). */
export type TenantResolver = () => string | undefined | TenantScope | undefined;

export interface AuthzServiceOptions {
  store: PermissionStore;
  superAdmin?: SuperAdminHook;
  resolveUserRef?: ResolveUserRef;
  tenant?: TenantResolver;
  /**
   * Opt-in tenant auto-scope (feature B). When a check gets no explicit tenant
   * and no `tenant` resolver yields one, default the tenant to a resolver's
   * value. Pass {@link tenantFromContext} to default to the active Agora
   * context's `tenantId`, or any custom resolver. Default (unset) leaves
   * behavior unchanged — no context → `''` global scope.
   */
  resolveTenant?: () => string | undefined;
  /**
   * Opt-in global-role bridge (feature C). Global role names that grant
   * super-admin (short-circuit allow). Read structurally from the active Agora
   * context store (`globalRoles`, written by authkit). No DB seeding.
   */
  superAdminRoles?: string[];
  /**
   * Resolve as roles do app para um usuário — a fonte que NÃO está no token nem no store authz
   * (tipicamente uma tabela do domínio, ex. `user_roles`). As roles retornadas entram na união do
   * `can()`/`hasRole()`/`scope()` e são mapeadas por {@link roleGrants}, exatamente como as roles
   * globais do contexto. Opcional: ausente → só token + store decidem.
   */
  resolveRoles?: (user: UserRef, scope?: TenantScope) => Promise<string[]> | string[];
  /**
   * Domain reverse seam — the reverse counterpart of {@link resolveRoles}. Given a role, return the
   * user ids/refs that hold it in the app's OWN role store (typically a domain table, e.g.
   * `user_roles`), the source that is neither in the token nor in the authz store. Its results join
   * the union of {@link AuthzService.usersWithRole}. Optional: absent → only the authz store and the
   * global seam contribute. Bare `string` ids are normalized to the default user type; a
   * {@link UserRefInput} object is normalized as-is.
   */
  resolveRoleMembers?: (
    role: string,
    scope?: TenantScope,
  ) => Promise<Array<string | UserRefInput>> | Array<string | UserRefInput>;
  /**
   * Global/IdP reverse seam — the reverse counterpart of the global context (token) role claim.
   * Given a role, return the user ids/refs that hold it as an IdP/global role (e.g. scanning the
   * authenticator's accounts by their `globalRoles`). authz owns the "global" concept so it can layer
   * global-specific policy later (e.g. `superAdminRoles`); the authenticator gains no role-query
   * method. Its results join the union of {@link AuthzService.usersWithRole}. Optional: absent → the
   * global side contributes nothing.
   */
  resolveGlobalRoleMembers?: (
    role: string,
    scope?: TenantScope,
  ) => Promise<Array<string | UserRefInput>> | Array<string | UserRefInput>;
  /**
   * Mapa role → permissões/wildcards, aplicado às roles EFETIVAS (contexto + resolver) sem seed no
   * store. (Antes: `globalRoleGrants`; renomeado porque não é só das roles globais.)
   */
  roleGrants?: Record<string, string[]>;
  /**
   * Query-scope registry (feature E). Pre-built {@link ScopeRegistry} mapping each
   * resource to a scope filter for {@link AuthzService.scope} / the Lucid
   * `accessibleBy` helper. A shared default registry is created when unset, so a
   * host may also register via {@link AuthzService.scopes}.
   */
  scopes?: ScopeRegistry;
}

function normalizeTenantResolver(value: string | TenantScope | undefined): TenantScope | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return { tenantId: value };
  return value;
}

/**
 * The authorization engine that Bouncer abilities consult. It maps a host user
 * to a {@link UserRef}, applies the super-admin hook, then resolves a permission
 * via the {@link PermissionStore} using WILDCARD matching (so `posts.*` grants
 * `posts.edit`). Roles are checked exactly.
 *
 * Resolution order for {@link can} mirrors the port:
 *   1. super-admin hook (may allow or deny);
 *   2. wildcard permission grant from the store (grant-only);
 *   3. otherwise deny.
 */
export class AuthzService {
  readonly store: PermissionStore;
  private readonly superAdmin: SuperAdminHook | undefined;
  private readonly resolveUserRef: ResolveUserRef;
  private readonly tenant: TenantResolver | undefined;
  private readonly resolveTenant: (() => string | undefined) | undefined;
  private readonly superAdminRoles: ReadonlySet<string>;
  private readonly roleGrants: Record<string, string[]> | undefined;
  private readonly resolveRolesFn:
    | ((user: UserRef, scope?: TenantScope) => Promise<string[]> | string[])
    | undefined;
  private readonly resolveRoleMembersFn:
    | ((
        role: string,
        scope?: TenantScope,
      ) => Promise<Array<string | UserRefInput>> | Array<string | UserRefInput>)
    | undefined;
  private readonly resolveGlobalRoleMembersFn:
    | ((
        role: string,
        scope?: TenantScope,
      ) => Promise<Array<string | UserRefInput>> | Array<string | UserRefInput>)
    | undefined;

  /** The query-scope registry (resource → scope filter). See {@link scope}. */
  readonly scopes: ScopeRegistry;

  constructor(options: AuthzServiceOptions) {
    this.store = options.store;
    this.superAdmin = options.superAdmin;
    this.resolveUserRef = options.resolveUserRef ?? defaultResolveUserRef;
    this.tenant = options.tenant;
    this.resolveTenant = options.resolveTenant;
    this.superAdminRoles = new Set(options.superAdminRoles ?? []);
    this.roleGrants = options.roleGrants;
    this.resolveRolesFn = options.resolveRoles;
    this.resolveRoleMembersFn = options.resolveRoleMembers;
    this.resolveGlobalRoleMembersFn = options.resolveGlobalRoleMembers;
    this.scopes = options.scopes ?? new ScopeRegistry();
  }

  /** Map a host user object to a canonical {@link UserRef} (or undefined). */
  refOf(user: unknown): UserRef | undefined {
    const input = this.resolveUserRef(user);
    if (input == null) return undefined;
    return normalizeUserRef(input);
  }

  /**
   * The active tenant scope. Precedence: explicit `scope` arg → configured
   * `tenant` resolver → opt-in `resolveTenant` (feature B, e.g. the Agora
   * context). When nothing yields a tenant, returns `undefined` (global `''`).
   */
  currentScope(scope?: TenantScope): TenantScope | undefined {
    if (scope) return scope;
    if (this.tenant) {
      const fromResolver = normalizeTenantResolver(this.tenant());
      if (fromResolver) return fromResolver;
    }
    if (this.resolveTenant) {
      const fromContext = this.resolveTenant();
      if (fromContext) return { tenantId: fromContext };
    }
    return undefined;
  }

  /**
   * The single super-admin guard, consulted identically by {@link can},
   * {@link hasRole}, and {@link hasAnyRole}. Returns:
   *
   * - `true`  → super-admin granted (caller should short-circuit allow);
   * - `false` → super-admin actively denied (caller should short-circuit deny);
   * - `undefined` → no verdict, fall through to normal resolution.
   *
   * It applies the {@link SuperAdminHook} first (the only hook whose `false`
   * denies), then the global super-admin roles (feature C).
   */
  private async superAdminVerdict(ref: UserRef, ability: string): Promise<boolean | undefined> {
    if (this.superAdmin) {
      const verdict = await this.superAdmin(ref, ability);
      if (verdict === true) return true;
      if (verdict === false) return false;
    }
    if (this.isGlobalSuperAdmin()) return true;
    return undefined;
  }

  /**
   * Global-role bridge (feature C): is any of the user's active global roles
   * (read structurally from the Agora context store) a configured super-admin
   * role?
   */
  private isGlobalSuperAdmin(): boolean {
    if (this.superAdminRoles.size === 0) return false;
    for (const role of globalRolesFromContext()) {
      if (this.superAdminRoles.has(role)) return true;
    }
    return false;
  }

  /**
   * The effective roles for an ALREADY-RESOLVED ref: the global roles from the
   * context (token) ∪ the app's roles (the {@link resolveRoles} seam) ∪ the
   * store's roles. Private — {@link can}, {@link scope} and {@link hasRole}
   * already hold a resolved `ref` and call this directly, so they never run
   * `refOf` twice. The public {@link effectiveRoles}/{@link effectivePermissions}
   * (consumed by `buildAuthzShare` in authz-react, which only has the host
   * user object) resolve `ref` once and delegate here.
   */
  async #effectiveRolesFor(ref: UserRef, tenant?: TenantScope): Promise<string[]> {
    const contextRoles = globalRolesFromContext();
    const appRoles = this.resolveRolesFn ? await this.resolveRolesFn(ref, tenant) : [];
    const storeRoles = await this.store.getRolesForUser(ref, tenant);
    return [...new Set([...contextRoles, ...appRoles, ...storeRoles])];
  }

  /**
   * As roles efetivas do usuário para decisão: as globais do contexto (token) unidas às do app
   * (o seam `resolveRoles`) e às do STORE. Público: o `buildAuthzShare` do authz-react o usa para o
   * gating de UI casar com a decisão de servidor.
   */
  async effectiveRoles(user: unknown, scope?: TenantScope): Promise<string[]> {
    const ref = this.refOf(user);
    if (!ref) return [];
    const tenant = this.currentScope(scope);
    return this.#effectiveRolesFor(ref, tenant);
  }

  /**
   * Todas as permissões efetivas do usuário: as do store unidas às concedidas por `roleGrants` sobre
   * as roles efetivas. Público — a fonte da verdade que `can()` e o `buildAuthzShare` compartilham.
   */
  async effectivePermissions(user: unknown, scope?: TenantScope): Promise<string[]> {
    const ref = this.refOf(user);
    if (!ref) return [];
    const tenant = this.currentScope(scope);
    const granted = await this.store.getPermissionsForUser(ref, tenant);
    const roles = await this.#effectiveRolesFor(ref, tenant);
    return [...new Set([...granted, ...this.rolePermissionGrants(roles)])];
  }

  /** As permissões concedidas por um conjunto de roles via {@link roleGrants} (sem seed no store). */
  private rolePermissionGrants(roles: readonly string[]): string[] {
    if (!this.roleGrants) return [];
    const grants: string[] = [];
    for (const role of roles) {
      const perms = this.roleGrants[role];
      if (perms) grants.push(...perms);
    }
    return grants;
  }

  /** A fresh per-request permission cache bound to the active store. */
  createCache(): PermissionCache {
    return new PermissionCache(this.store);
  }

  /**
   * Does the user hold `permission` (with wildcard matching)? Honors the
   * super-admin hook. Pass a `cache` to coalesce reads across a request.
   */
  async can(
    user: unknown,
    permission: string,
    options: { scope?: TenantScope; cache?: PermissionCache } = {},
  ): Promise<boolean> {
    const ref = this.refOf(user);
    if (!ref) return false;

    const superAdmin = await this.superAdminVerdict(ref, permission);
    if (superAdmin !== undefined) return superAdmin;

    const scope = this.currentScope(options.scope);
    // Single permission-union site: store grants ∪ roleGrants over the effective roles
    // (context ∪ resolveRoles ∪ store — feature C generalized by the resolveRoles seam).
    const roles = await this.#effectiveRolesFor(ref, scope);
    const granted = options.cache
      ? await options.cache.getPermissions(ref, scope)
      : await this.store.getPermissionsForUser(ref, scope);
    return permissionSatisfied([...granted, ...this.rolePermissionGrants(roles)], permission);
  }

  /**
   * Resolve the QUERY-SCOPE constraint for `user` against `resource` — the
   * `accessibleBy` / Pundit `policy_scope` concept. Returns an ORM-neutral
   * {@link ScopeConstraint} the Lucid `accessibleBy` helper turns into a
   * parameterized `WHERE`.
   *
   * Mirrors {@link can}'s resolution order so scoping stays consistent with
   * single-resource decisions:
   *   1. super-admin (hook or global role) grants → `allow-all` (no filter);
   *   2. a wildcard permission grant for `action` → `allow-all`;
   *   3. the resource's registered scope filter → its constraint (fed the user's
   *      effective roles/permissions/tenant so it derives from the SAME authz data);
   *   4. otherwise (anonymous, or no scope registered) → `deny-all` (fail-closed).
   *
   * `action` (default `'viewAny'`) names the permission-grant check and is passed to
   * the scope filter as the ability being scoped.
   */
  async scope(
    user: unknown,
    resource: ResourceKey,
    options: { action?: string; scope?: TenantScope; cache?: PermissionCache } = {},
  ): Promise<ScopeConstraint> {
    const action = options.action ?? 'viewAny';
    const ref = this.refOf(user);
    // 4 (anonymous): no user → deny-all.
    if (!ref) return scopeNone;

    // 1. Super-admin (hook or global role) → allow-all. A `false` here actively
    //    denies, mirroring `can`.
    const superAdmin = await this.superAdminVerdict(ref, action);
    if (superAdmin === true) return scopeAll;
    if (superAdmin === false) return scopeNone;

    const tenant = this.currentScope(options.scope);
    const granted = options.cache
      ? await options.cache.getPermissions(ref, tenant)
      : await this.store.getPermissionsForUser(ref, tenant);
    const effective = await this.#effectiveRolesFor(ref, tenant);
    const permissions = [...granted, ...this.rolePermissionGrants(effective)];

    // 2. A wildcard permission grant for the scope action → allow-all.
    if (permissionSatisfied(permissions, action)) return scopeAll;

    // 3. The resource's registered scope filter, fed the user's effective roles
    // (context ∪ resolveRoles ∪ store — #effectiveRolesFor already includes store roles).
    const filter = this.scopes.resolve(resource);
    if (!filter) return scopeNone; // fail-closed: unknown resource sees no rows.

    return normalizeScope(
      await filter({ user: ref, action, permissions, roles: effective, tenant }),
    );
  }

  /**
   * Does the user have the named role (exact match, tenant-aware)? Checks the
   * EFFECTIVE roles — context (token) ∪ app (`resolveRoles`) ∪ store — so a role
   * asserted by the token or the app's resolver is recognized exactly like a
   * store-assigned one.
   */
  async hasRole(
    user: unknown,
    role: string,
    options: { scope?: TenantScope } = {},
  ): Promise<boolean> {
    const ref = this.refOf(user);
    if (!ref) return false;

    const superAdmin = await this.superAdminVerdict(ref, `role:${role}`);
    if (superAdmin !== undefined) return superAdmin;

    const scope = this.currentScope(options.scope);
    const roles = await this.#effectiveRolesFor(ref, scope);
    return roles.includes(role);
  }

  /**
   * Does the user have ANY of the named roles? Checks the same EFFECTIVE roles
   * as {@link hasRole} — context (token) ∪ app (`resolveRoles`) ∪ store — so
   * `hasAnyRole` never disagrees with `hasRole` for the same input.
   */
  async hasAnyRole(
    user: unknown,
    roles: string[],
    options: { scope?: TenantScope } = {},
  ): Promise<boolean> {
    const ref = this.refOf(user);
    if (!ref) return false;

    const superAdmin = await this.superAdminVerdict(ref, `role:${roles.join(',')}`);
    if (superAdmin !== undefined) return superAdmin;

    const scope = this.currentScope(options.scope);
    const owned = new Set(await this.#effectiveRolesFor(ref, scope));
    return roles.some((r) => owned.has(r));
  }

  /**
   * The reverse of {@link effectiveRoles}: every user with `role` as an EFFECTIVE role — the union of
   * the authz store (`getUsersForRole`) ∪ the domain reverse seam (`resolveRoleMembers`) ∪ the
   * global/IdP reverse seam (`resolveGlobalRoleMembers`). The three sources run in parallel; an
   * absent seam contributes nothing. Bare `string` ids are normalized to the default user type (the
   * same normalization used everywhere refs are keyed), `UserRefInput` objects via the existing
   * normalizer; results are deduped by `(type, id)`. The tenant scope defaults consistently with
   * {@link hasRole}/{@link effectiveRoles} via {@link currentScope}.
   */
  async usersWithRole(role: string, scope?: TenantScope): Promise<UserRef[]> {
    const tenant = this.currentScope(scope);
    const [storeUsers, roleMembers, globalRoleMembers] = await Promise.all([
      this.store.getUsersForRole(role, tenant),
      this.resolveRoleMembersFn ? this.resolveRoleMembersFn(role, tenant) : [],
      this.resolveGlobalRoleMembersFn ? this.resolveGlobalRoleMembersFn(role, tenant) : [],
    ]);

    const seen = new Set<string>();
    const out: UserRef[] = [];
    const add = (input: string | UserRefInput): void => {
      const ref = normalizeUserRef(input);
      const key = `${ref.type} ${ref.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(ref);
    };
    for (const ref of storeUsers) add(ref);
    for (const member of roleMembers) add(member);
    for (const member of globalRoleMembers) add(member);
    return out;
  }
}
