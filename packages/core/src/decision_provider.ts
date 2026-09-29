import type { ResourceKey, ScopeConstraint } from './scope.js';
import type { SubjectRef, TenantScope } from './subject_ref.js';

/**
 * What a {@link DecisionProvider} answers for one `(user, ability, resource)`:
 *
 * - `true` / `{ allowed: true }` → **allow** (short-circuits the service);
 * - `false` / `{ allowed: false, message? }` → **deny** (short-circuits the service — unlike the
 *   grant-only RBAC store, a decision provider CAN deny);
 * - `undefined` / `null` → **abstain**: the provider has no opinion (e.g. the resource kind or the
 *   tenant is not governed by the external engine) and the service continues with its normal
 *   resolution (RBAC grants from the store and `roleGrants`).
 */
export type DecisionVerdict = boolean | { allowed: boolean; message?: string } | null | undefined;

/** One `(ability, resource)` pair in a {@link DecisionProvider.decideMany} batch. */
export interface DecisionRequest {
  ability: string;
  resource?: unknown;
}

/**
 * What the service already resolved for the check, handed to the provider so it does not have
 * to redo it: the mapped {@link SubjectRef} (`undefined` for an anonymous / unmappable user) and
 * the active tenant scope (`undefined` → global).
 */
export interface DecisionContext {
  ref: SubjectRef | undefined;
  tenant: TenantScope | undefined;
}

/**
 * Optional seam for an **external policy decision point** (Cerbos, OPA, OpenFGA, a remote authz
 * service, …) — the authoritative, resource-aware counterpart of the grant-only RBAC store.
 * Configure it with `decisionProvider` in `config/authz.ts` (or the {@link AuthzService}
 * constructor options).
 *
 * `user` is the HOST user object exactly as it was passed to the check (`undefined`/`null` for an
 * anonymous caller), so a provider can build a rich principal (roles, attributes); the mapped
 * {@link SubjectRef} and the active tenant arrive in the {@link DecisionContext}.
 *
 * ## Precedence (`authz.can` / the Bouncer `can` ability)
 *
 * 1. `superAdmin` hook (receives the resource as 3rd argument) and `superAdminRoles` —
 *    allow/deny short-circuit;
 * 2. **decision provider** `decide` — allow/deny short-circuit, `undefined` abstains;
 * 3. RBAC: wildcard permission grants from the store ∪ `roleGrants` over the effective roles;
 * 4. otherwise deny.
 *
 * Your own Bouncer abilities/policies are outside the service: they run only when you call them,
 * and see the provider's verdict only if they delegate to `authz.can`. Role checks
 * (`hasRole`/`hasAnyRole`) are NOT routed through the provider — roles are data, not decisions.
 *
 * The provider is also consulted for **anonymous callers** so an engine can allow public access;
 * abstain to keep the default anonymous-deny.
 *
 * ## Batching
 *
 * `authz.canMany(...)` calls {@link decideMany} ONCE for the whole batch when implemented (a list
 * page with N cards costs one engine round-trip instead of N); otherwise `decide` per item. If
 * `decideMany` throws (or returns the wrong number of verdicts), every item falls back to its own
 * `decide`.
 *
 * ## Query scopes
 *
 * `authz.scope(...)` / `accessibleBy(...)` call {@link planScope} right after the super-admin
 * check. A returned {@link ScopeConstraint} is used as-is (e.g. an engine's query plan mapped onto
 * the scope AST — see `@adonis-agora/authz/cerbos`); `undefined` abstains and the service falls
 * back to the permission grant / the registered scope filter.
 *
 * Errors thrown by `decide`/`planScope` propagate (the check fails loudly). Providers that talk to
 * a remote engine should pick their own failure mode — the Cerbos adapter fails CLOSED (deny).
 */
export interface DecisionProvider {
  decide(
    user: unknown,
    ability: string,
    resource: unknown,
    context: DecisionContext,
  ): DecisionVerdict | Promise<DecisionVerdict>;
  /** Optional batch form; must return one verdict per request, in order. */
  decideMany?(
    user: unknown,
    requests: DecisionRequest[],
    context: DecisionContext,
  ): Promise<DecisionVerdict[]>;
  /** Optional query-plan → scope mapping. `undefined` = abstain. */
  planScope?(
    user: unknown,
    resource: ResourceKey,
    ability: string,
    context: DecisionContext,
  ): ScopeConstraint | undefined | Promise<ScopeConstraint | undefined>;
}

/** A normalized verdict: `allowed` is `undefined` when the provider abstained. */
export interface NormalizedVerdict {
  allowed: boolean | undefined;
  message?: string;
}

/** Normalize a {@link DecisionVerdict} (boolean / object / nullish) into {@link NormalizedVerdict}. */
export function normalizeVerdict(verdict: DecisionVerdict): NormalizedVerdict {
  if (verdict == null) return { allowed: undefined };
  if (typeof verdict === 'boolean') return { allowed: verdict };
  return verdict.message !== undefined
    ? { allowed: verdict.allowed === true, message: verdict.message }
    : { allowed: verdict.allowed === true };
}
