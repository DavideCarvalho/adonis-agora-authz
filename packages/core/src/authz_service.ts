import { globalRolesFromContext } from './agora/context.js';
import {
  type DecisionContext,
  type DecisionProvider,
  type DecisionVerdict,
  normalizeVerdict,
} from './decision_provider.js';
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
  defaultResolveSubjectRef,
  normalizeSubjectRef,
  type ResolveSubjectRef,
  type SubjectRef,
  type SubjectRefInput,
  type TenantScope,
} from './subject_ref.js';

export { tenantFromContext } from './agora/context.js';

/**
 * Super-admin hook (ported from nestjs-authz). Receives the mapped {@link SubjectRef},
 * the ability/permission being checked and — when there is one — the resource: the
 * `resource` passed to {@link AuthzService.can} / the Bouncer `can` ability, or the
 * {@link ResourceKey} for {@link AuthzService.scope} (so a hook can scope its bypass).
 * Role checks pass no resource.
 *
 * - `true`  → allow (short-circuit).
 * - `false` → deny (short-circuit). Super-admin is the only hook whose `false`
 *   actively denies.
 * - nullish → fall through to the normal RBAC resolution.
 */
export type SuperAdminHook = (
  user: SubjectRef,
  ability: string,
  resource?: unknown,
) => boolean | undefined | Promise<boolean | undefined>;

/**
 * Why a permission check resolved the way it did — the "why" behind a 403 (or a grant).
 *
 * - `super-admin` — the `superAdmin` hook or a `superAdminRoles` role decided;
 * - `decision-provider` — the external {@link DecisionProvider} allowed or denied;
 * - `permission` — an RBAC grant (store or `roleGrants`, wildcard-aware) satisfied it;
 * - `anonymous` — no user could be mapped (and nothing above allowed);
 * - `no-grant` — a known user without a matching grant.
 */
export type AuthzDecisionReason =
  | 'super-admin'
  | 'decision-provider'
  | 'permission'
  | 'anonymous'
  | 'no-grant';

/** The outcome of {@link AuthzService.check}: the verdict, its reason and an optional message. */
export interface AuthzDecision {
  allowed: boolean;
  reason: AuthzDecisionReason;
  /** A human-readable reason, when the deciding source supplied one (e.g. a decision provider). */
  message?: string;
}

/** Options accepted by {@link AuthzService.check} / {@link AuthzService.can}. */
export interface AuthzCheckOptions {
  /** Explicit tenant scope (else resolved from the service's tenant config). */
  scope?: TenantScope;
  /** A per-request cache to coalesce store reads. */
  cache?: PermissionCache;
  /**
   * The resource the check is about (e.g. a model instance). Handed to the `superAdmin` hook
   * and the {@link DecisionProvider}; RBAC grants are model-less and ignore it.
   */
  resource?: unknown;
}

/** One item of {@link AuthzService.checkMany} / {@link AuthzService.canMany}. */
export interface AuthzCheckRequest {
  permission: string;
  resource?: unknown;
}

/** Reads the active tenant for the current request (e.g. from HTTP context). */
export type TenantResolver = () => string | undefined | TenantScope | undefined;

export interface AuthzServiceOptions {
  store: PermissionStore;
  superAdmin?: SuperAdminHook;
  resolveSubjectRef?: ResolveSubjectRef;
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
  resolveRoles?: (user: SubjectRef, scope?: TenantScope) => Promise<string[]> | string[];
  /**
   * Domain reverse seam — the reverse counterpart of {@link resolveRoles}. Given a role, return the
   * user ids/refs that hold it in the app's OWN role store (typically a domain table, e.g.
   * `user_roles`), the source that is neither in the token nor in the authz store. Its results join
   * the union of {@link AuthzService.subjectsWithRole}. Optional: absent → only the authz store and the
   * global seam contribute. Bare `string` ids are normalized to the default user type; a
   * {@link SubjectRefInput} object is normalized as-is.
   */
  resolveRoleMembers?: (
    role: string,
    scope?: TenantScope,
  ) => Promise<Array<string | SubjectRefInput>> | Array<string | SubjectRefInput>;
  /**
   * Global/IdP reverse seam — the reverse counterpart of the global context (token) role claim.
   * Given a role, return the user ids/refs that hold it as an IdP/global role (e.g. scanning the
   * authenticator's accounts by their `globalRoles`). authz owns the "global" concept so it can layer
   * global-specific policy later (e.g. `superAdminRoles`); the authenticator gains no role-query
   * method. Its results join the union of {@link AuthzService.subjectsWithRole}. Optional: absent → the
   * global side contributes nothing.
   */
  resolveGlobalRoleMembers?: (
    role: string,
    scope?: TenantScope,
  ) => Promise<Array<string | SubjectRefInput>> | Array<string | SubjectRefInput>;
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
  /**
   * External policy decision point (Cerbos, OPA, …). Consulted right after the super-admin
   * check by {@link AuthzService.can}/{@link AuthzService.check}/{@link AuthzService.canMany}
   * (`decide`/`decideMany`) and by {@link AuthzService.scope} (`planScope`). It can allow,
   * deny or abstain (`undefined`). See {@link DecisionProvider} for the full precedence.
   */
  decisionProvider?: DecisionProvider;
}

function normalizeTenantResolver(value: string | TenantScope | undefined): TenantScope | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return { tenantId: value };
  return value;
}

/**
 * The authorization engine that Bouncer abilities consult. It maps a host user
 * to a {@link SubjectRef}, applies the super-admin hook, then resolves a permission
 * via the {@link PermissionStore} using WILDCARD matching (so `posts.*` grants
 * `posts.edit`). Roles are checked exactly.
 *
 * Resolution order for {@link can} mirrors the port:
 *   1. super-admin hook / `superAdminRoles` (may allow or deny);
 *   2. the optional {@link DecisionProvider} (may allow, deny or abstain);
 *   3. wildcard permission grant from the store ∪ `roleGrants` (grant-only);
 *   4. otherwise deny.
 */
export class AuthzService {
  readonly store: PermissionStore;
  private readonly superAdmin: SuperAdminHook | undefined;
  private readonly resolveSubjectRef: ResolveSubjectRef;
  private readonly tenant: TenantResolver | undefined;
  private readonly resolveTenant: (() => string | undefined) | undefined;
  private readonly superAdminRoles: ReadonlySet<string>;
  private readonly roleGrants: Record<string, string[]> | undefined;
  private readonly resolveRolesFn:
    | ((user: SubjectRef, scope?: TenantScope) => Promise<string[]> | string[])
    | undefined;
  private readonly resolveRoleMembersFn:
    | ((
        role: string,
        scope?: TenantScope,
      ) => Promise<Array<string | SubjectRefInput>> | Array<string | SubjectRefInput>)
    | undefined;
  private readonly resolveGlobalRoleMembersFn:
    | ((
        role: string,
        scope?: TenantScope,
      ) => Promise<Array<string | SubjectRefInput>> | Array<string | SubjectRefInput>)
    | undefined;

  /** The query-scope registry (resource → scope filter). See {@link scope}. */
  readonly scopes: ScopeRegistry;

  /** The external decision point, when configured. See {@link DecisionProvider}. */
  readonly decisionProvider: DecisionProvider | undefined;

  constructor(options: AuthzServiceOptions) {
    this.store = options.store;
    this.superAdmin = options.superAdmin;
    this.resolveSubjectRef = options.resolveSubjectRef ?? defaultResolveSubjectRef;
    this.tenant = options.tenant;
    this.resolveTenant = options.resolveTenant;
    this.superAdminRoles = new Set(options.superAdminRoles ?? []);
    this.roleGrants = options.roleGrants;
    this.resolveRolesFn = options.resolveRoles;
    this.resolveRoleMembersFn = options.resolveRoleMembers;
    this.resolveGlobalRoleMembersFn = options.resolveGlobalRoleMembers;
    this.scopes = options.scopes ?? new ScopeRegistry();
    this.decisionProvider = options.decisionProvider;
  }

  /** Map a host user object to a canonical {@link SubjectRef} (or undefined). */
  refOf(user: unknown): SubjectRef | undefined {
    const input = this.resolveSubjectRef(user);
    if (input == null) return undefined;
    return normalizeSubjectRef(input);
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
  private async superAdminVerdict(
    ref: SubjectRef,
    ability: string,
    resource?: unknown,
  ): Promise<boolean | undefined> {
    if (this.superAdmin) {
      const verdict =
        resource === undefined
          ? await this.superAdmin(ref, ability)
          : await this.superAdmin(ref, ability, resource);
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
   * store's roles. {@link can}, {@link scope} and {@link hasRole} already hold a
   * resolved `ref` and call this directly, so they never run `refOf` twice; the
   * public {@link effectiveRoles}/{@link effectivePermissions} (consumed by
   * `buildAuthzShare` in authz-react, which only has the host user object)
   * resolve `ref` once and delegate here. Public so the lazy service singleton
   * (`services/main`) can build a {@link PermissionCache} over it.
   */
  async effectiveRolesForRef(ref: SubjectRef, tenant?: TenantScope): Promise<string[]> {
    const contextRoles = globalRolesFromContext();
    const appRoles = this.resolveRolesFn ? await this.resolveRolesFn(ref, tenant) : [];
    const storeRoles = await this.store.getRolesForSubject(ref, tenant);
    return [...new Set([...contextRoles, ...appRoles, ...storeRoles])];
  }

  /**
   * As roles efetivas do usuário para decisão: as globais do contexto (token) unidas às do app
   * (o seam `resolveRoles`) e às do STORE. Público: o `buildAuthzShare` do authz-react o usa para o
   * gating de UI casar com a decisão de servidor. Passa `cache` para partilhar a leitura única do
   * request (o seam e o store correm uma só vez por usuário+tenant).
   */
  async effectiveRoles(
    user: unknown,
    scope?: TenantScope,
    options: { cache?: PermissionCache } = {},
  ): Promise<string[]> {
    const ref = this.refOf(user);
    if (!ref) return [];
    const tenant = this.currentScope(scope);
    return options.cache
      ? options.cache.getRoles(ref, tenant)
      : this.effectiveRolesForRef(ref, tenant);
  }

  /**
   * Todas as permissões efetivas do usuário: as do store unidas às concedidas por `roleGrants` sobre
   * as roles efetivas. Público — a fonte da verdade que `can()` e o `buildAuthzShare` compartilham.
   * Com `cache`, as duas leituras (roles e permissões) saem do memo do request.
   */
  async effectivePermissions(
    user: unknown,
    scope?: TenantScope,
    options: { cache?: PermissionCache } = {},
  ): Promise<string[]> {
    const ref = this.refOf(user);
    if (!ref) return [];
    const tenant = this.currentScope(scope);
    const granted = options.cache
      ? [...(await options.cache.getPermissions(ref, tenant))]
      : await this.store.getPermissionsForSubject(ref, tenant);
    const roles = options.cache
      ? await options.cache.getRoles(ref, tenant)
      : await this.effectiveRolesForRef(ref, tenant);
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

  /**
   * A fresh per-request cache bound to the active store. The service injects its
   * own effective-roles union (context ∪ `resolveRoles` ∪ store) so the cache
   * memoizes BOTH dimensions a check reads — one role resolution and one
   * permission read per (user, tenant) per request, no matter how many
   * `can()`/`hasRole()` calls the request makes.
   */
  createCache(): PermissionCache {
    return new PermissionCache(this.store, (ref, tenant) => this.effectiveRolesForRef(ref, tenant));
  }

  /**
   * Does the user hold `permission` (with wildcard matching)? Honors the
   * super-admin hook and the {@link DecisionProvider}. Pass a `cache` to coalesce
   * reads across a request, and `resource` to let the super-admin hook / decision
   * provider see what the check is about. See {@link check} for the reasoned form.
   */
  async can(user: unknown, permission: string, options: AuthzCheckOptions = {}): Promise<boolean> {
    return (await this.check(user, permission, options)).allowed;
  }

  /**
   * {@link can} with the "why": the verdict, the {@link AuthzDecisionReason} and the deciding
   * source's message (e.g. a decision provider's deny message). Resolution order:
   *   1. super-admin (hook or global role) — allow/deny;
   *   2. {@link DecisionProvider.decide} — allow/deny, `undefined` abstains (also for anonymous);
   *   3. anonymous → deny;
   *   4. RBAC grant (store ∪ `roleGrants`, wildcard-aware) → allow, else deny.
   */
  async check(
    user: unknown,
    permission: string,
    options: AuthzCheckOptions = {},
  ): Promise<AuthzDecision> {
    return this.resolveCheck(user, this.refOf(user), permission, options, undefined);
  }

  /**
   * Batch {@link can}: one boolean per request, in order. With a {@link DecisionProvider} that
   * implements `decideMany`, the whole batch costs ONE engine round-trip; RBAC reads share one
   * per-request cache.
   */
  async canMany(
    user: unknown,
    requests: AuthzCheckRequest[],
    options: Omit<AuthzCheckOptions, 'resource'> = {},
  ): Promise<boolean[]> {
    return (await this.checkMany(user, requests, options)).map((d) => d.allowed);
  }

  /**
   * Batch {@link check}. Super-admin is resolved per item first; the items it does not decide go
   * to {@link DecisionProvider.decideMany} in a single call (falling back to per-item `decide`
   * when `decideMany` is absent, throws, or returns the wrong number of verdicts); the rest
   * resolve through RBAC with a shared cache (unless one is passed).
   */
  async checkMany(
    user: unknown,
    requests: AuthzCheckRequest[],
    options: Omit<AuthzCheckOptions, 'resource'> = {},
  ): Promise<AuthzDecision[]> {
    const ref = this.refOf(user);
    const cache = options.cache ?? this.createCache();
    const base: AuthzCheckOptions = { ...options, cache };
    const results: Array<AuthzDecision | undefined> = [];
    const pending: number[] = [];
    for (const [index, request] of requests.entries()) {
      const superAdmin = ref
        ? await this.superAdminVerdict(ref, request.permission, request.resource)
        : undefined;
      if (superAdmin !== undefined) {
        results[index] = { allowed: superAdmin, reason: 'super-admin' };
      } else {
        results[index] = undefined;
        pending.push(index);
      }
    }

    const prefetched = await this.prefetchDecisions(
      user,
      ref,
      pending.map((i) => requests[i] as AuthzCheckRequest),
      options.scope,
    );
    for (const [position, index] of pending.entries()) {
      const request = requests[index] as AuthzCheckRequest;
      results[index] = await this.resolveCheck(
        user,
        ref,
        request.permission,
        { ...base, resource: request.resource },
        prefetched ? { verdict: prefetched[position] } : undefined,
        true,
      );
    }
    return results as AuthzDecision[];
  }

  /**
   * One {@link DecisionProvider.decideMany} round-trip for a batch, when supported. `undefined`
   * → per-item `decide`. A failing batch call degrades to per-item calls, never fails the batch.
   */
  private async prefetchDecisions(
    user: unknown,
    ref: SubjectRef | undefined,
    requests: AuthzCheckRequest[],
    scope: TenantScope | undefined,
  ): Promise<DecisionVerdict[] | undefined> {
    const provider = this.decisionProvider;
    if (!provider || typeof provider.decideMany !== 'function' || requests.length === 0) {
      return undefined;
    }
    try {
      const verdicts = await provider.decideMany(
        user,
        requests.map((r) =>
          r.resource === undefined
            ? { ability: r.permission }
            : { ability: r.permission, resource: r.resource },
        ),
        this.decisionContext(ref, scope),
      );
      if (!Array.isArray(verdicts) || verdicts.length !== requests.length) return undefined;
      return verdicts;
    } catch {
      return undefined;
    }
  }

  private decisionContext(ref: SubjectRef | undefined, scope?: TenantScope): DecisionContext {
    return { ref, tenant: this.currentScope(scope) };
  }

  /** The single decision path behind {@link check}/{@link checkMany}. */
  private async resolveCheck(
    user: unknown,
    ref: SubjectRef | undefined,
    permission: string,
    options: AuthzCheckOptions,
    prefetched: { verdict: DecisionVerdict } | undefined,
    superAdminResolved = false,
  ): Promise<AuthzDecision> {
    // 1. Super-admin (hook or global role), with the resource so a hook can scope its bypass.
    if (ref && !superAdminResolved) {
      const superAdmin = await this.superAdminVerdict(ref, permission, options.resource);
      if (superAdmin !== undefined) return { allowed: superAdmin, reason: 'super-admin' };
    }

    // 2. External decision point: authoritative allow OR deny; `undefined` abstains.
    //    Consulted for anonymous callers too, so an engine may allow public access.
    const provider = this.decisionProvider;
    if (provider) {
      const verdict = normalizeVerdict(
        prefetched
          ? prefetched.verdict
          : await provider.decide(
              user,
              permission,
              options.resource,
              this.decisionContext(ref, options.scope),
            ),
      );
      if (verdict.allowed !== undefined) {
        return verdict.message !== undefined
          ? { allowed: verdict.allowed, reason: 'decision-provider', message: verdict.message }
          : { allowed: verdict.allowed, reason: 'decision-provider' };
      }
    }

    // 3. Anonymous → deny.
    if (!ref) return { allowed: false, reason: 'anonymous' };

    // 4. RBAC. Single permission-union site: store grants ∪ roleGrants over the effective roles
    // (context ∪ resolveRoles ∪ store — feature C generalized by the resolveRoles seam).
    // Both reads go through the cache when one is passed: one role resolution and
    // one permission read per (user, tenant) per request.
    const scope = this.currentScope(options.scope);
    const roles = options.cache
      ? await options.cache.getRoles(ref, scope)
      : await this.effectiveRolesForRef(ref, scope);
    const granted = options.cache
      ? await options.cache.getPermissions(ref, scope)
      : await this.store.getPermissionsForSubject(ref, scope);
    const allowed = permissionSatisfied(
      [...granted, ...this.rolePermissionGrants(roles)],
      permission,
    );
    return { allowed, reason: allowed ? 'permission' : 'no-grant' };
  }

  /**
   * Resolve the QUERY-SCOPE constraint for `user` against `resource` — the
   * `accessibleBy` / Pundit `policy_scope` concept. Returns an ORM-neutral
   * {@link ScopeConstraint} the Lucid `accessibleBy` helper turns into a
   * parameterized `WHERE`.
   *
   * Mirrors {@link can}'s resolution order so scoping stays consistent with
   * single-resource decisions:
   *   1. super-admin (hook or global role) grants → `allow-all` (no filter); the hook
   *      receives the `resource` key as its 3rd argument;
   *   1b. the {@link DecisionProvider}'s `planScope` → its constraint as-is (e.g. a
   *      Cerbos query plan); `undefined` abstains. Consulted for anonymous users too;
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

    // 1. Super-admin (hook or global role) → allow-all. A `false` here actively
    //    denies, mirroring `can`.
    if (ref) {
      const superAdmin = await this.superAdminVerdict(ref, action, resource);
      if (superAdmin === true) return scopeAll;
      if (superAdmin === false) return scopeNone;
    }

    const tenant = this.currentScope(options.scope);

    // 1b. External decision point's query plan (e.g. Cerbos PlanResources) → used as-is;
    //     `undefined` abstains.
    const planner = this.decisionProvider;
    if (planner && typeof planner.planScope === 'function') {
      const planned = await planner.planScope(user, resource, action, { ref, tenant });
      if (planned !== undefined) return planned;
    }

    // 4 (anonymous): no user → deny-all.
    if (!ref) return scopeNone;

    const granted = options.cache
      ? await options.cache.getPermissions(ref, tenant)
      : await this.store.getPermissionsForSubject(ref, tenant);
    const effective = options.cache
      ? await options.cache.getRoles(ref, tenant)
      : await this.effectiveRolesForRef(ref, tenant);
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
   * store-assigned one. Pass `cache` to share the request's single role read.
   */
  async hasRole(
    user: unknown,
    role: string,
    options: { scope?: TenantScope; cache?: PermissionCache } = {},
  ): Promise<boolean> {
    const ref = this.refOf(user);
    if (!ref) return false;

    const superAdmin = await this.superAdminVerdict(ref, `role:${role}`);
    if (superAdmin !== undefined) return superAdmin;

    const scope = this.currentScope(options.scope);
    const roles = options.cache
      ? await options.cache.getRoles(ref, scope)
      : await this.effectiveRolesForRef(ref, scope);
    return roles.includes(role);
  }

  /**
   * Does the user have ANY of the named roles? Checks the same EFFECTIVE roles
   * as {@link hasRole} — context (token) ∪ app (`resolveRoles`) ∪ store — so
   * `hasAnyRole` never disagrees with `hasRole` for the same input. Honors
   * `cache` like {@link hasRole}.
   */
  async hasAnyRole(
    user: unknown,
    roles: string[],
    options: { scope?: TenantScope; cache?: PermissionCache } = {},
  ): Promise<boolean> {
    const ref = this.refOf(user);
    if (!ref) return false;

    const superAdmin = await this.superAdminVerdict(ref, `role:${roles.join(',')}`);
    if (superAdmin !== undefined) return superAdmin;

    const scope = this.currentScope(options.scope);
    const owned = new Set(
      options.cache
        ? await options.cache.getRoles(ref, scope)
        : await this.effectiveRolesForRef(ref, scope),
    );
    return roles.some((r) => owned.has(r));
  }

  /**
   * The reverse of {@link effectiveRoles}: every user with `role` as an EFFECTIVE role — the union of
   * the authz store (`getSubjectsForRole`) ∪ the domain reverse seam (`resolveRoleMembers`) ∪ the
   * global/IdP reverse seam (`resolveGlobalRoleMembers`). The three sources run in parallel; an
   * absent seam contributes nothing. Bare `string` ids are normalized to the default user type (the
   * same normalization used everywhere refs are keyed), `SubjectRefInput` objects via the existing
   * normalizer; results are deduped by `(type, id)`. The tenant scope defaults consistently with
   * {@link hasRole}/{@link effectiveRoles} via {@link currentScope}.
   */
  async subjectsWithRole(role: string, scope?: TenantScope): Promise<SubjectRef[]> {
    const tenant = this.currentScope(scope);
    const [storeUsers, roleMembers, globalRoleMembers] = await Promise.all([
      this.store.getSubjectsForRole(role, tenant),
      this.resolveRoleMembersFn ? this.resolveRoleMembersFn(role, tenant) : [],
      this.resolveGlobalRoleMembersFn ? this.resolveGlobalRoleMembersFn(role, tenant) : [],
    ]);

    const seen = new Set<string>();
    const out: SubjectRef[] = [];
    const add = (input: string | SubjectRefInput): void => {
      const ref = normalizeSubjectRef(input);
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
