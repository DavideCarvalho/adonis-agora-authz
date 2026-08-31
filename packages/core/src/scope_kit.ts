/**
 * `@adonis-agora/authz/scope` — the query-scope DSL for Lucid.
 *
 * One-stop import for constraining a Lucid query to the rows a user may access for a
 * given action/resource: the {@link accessibleBy} helper, the {@link applyScopeConstraint}
 * primitive, and the ORM-neutral constraint builders (`eq`, `whereIn`, `and`, `or`, …)
 * a registered {@link ScopeFilter} returns. Matches the `/http`, `/provisioning`
 * subpath pattern.
 */

export type { AccessibleByOptions, ScopeableQuery } from './lucid_scope.js';
export { accessibleBy, applyScopeConstraint } from './lucid_scope.js';
export type {
  ResourceKey,
  ScopeAll,
  ScopeCondition,
  ScopeConstraint,
  ScopeFilter,
  ScopeFilterContext,
  ScopeGroup,
  ScopeNode,
  ScopeNone,
  ScopeOperator,
  ScopeResult,
} from './scope.js';
export {
  and,
  assertSafeIdentifier,
  eq,
  normalizeScope,
  or,
  SAFE_IDENTIFIER,
  ScopeRegistry,
  scopeAll,
  scopeNone,
  where,
  whereIn,
} from './scope.js';
