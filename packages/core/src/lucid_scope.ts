/**
 * Lucid query-scope adapter — the `accessibleBy` helper.
 *
 * Mirrors the nestjs-authz TypeORM/MikroORM scope adapters: an ORM-neutral
 * {@link ScopeConstraint} (resolved by {@link AuthzService.scope} from the SAME
 * authorization data `can`/`hasRole` use) is compiled into `where` clauses on a Lucid
 * query builder. `allow-all` adds nothing (every row visible); `deny-all` adds an
 * always-false predicate (no rows); a condition AST becomes parameterized,
 * identifier-safe `where`/`whereIn`/`whereNull` clauses.
 *
 * The query builder is typed structurally (the slice we touch), so this module imports
 * with no hard dependency on `@adonisjs/lucid` — keeping the optional-peer coupling
 * minimal, exactly like {@link LucidPermissionStore}.
 */

import type { AuthzService } from './authz_service.js';
import {
  type ScopeCondition,
  type ScopeConstraint,
  type ScopeNode,
  type ScopeOperator,
  assertSafeIdentifier,
} from './scope.js';
import type { ResourceKey } from './scope.js';
import type { TenantScope } from './user_ref.js';

/**
 * The slice of a Lucid `ModelQueryBuilderContract` (or any Knex-style chainable) the
 * adapter relies on. Structural so we never import a concrete Lucid type. Every method
 * returns the builder for chaining.
 */
export interface ScopeableQuery {
  where(callback: (query: ScopeableQuery) => void): ScopeableQuery;
  where(column: string, operator: string, value: unknown): ScopeableQuery;
  orWhere(callback: (query: ScopeableQuery) => void): ScopeableQuery;
  whereIn(column: string, values: readonly unknown[]): ScopeableQuery;
  whereNotIn(column: string, values: readonly unknown[]): ScopeableQuery;
  whereNull(column: string): ScopeableQuery;
  whereNotNull(column: string): ScopeableQuery;
  whereRaw(sql: string, bindings?: readonly unknown[]): ScopeableQuery;
}

/** Knex/Lucid operator tokens for the binary comparison operators. */
const BINARY_OPS: Partial<Record<ScopeOperator, string>> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/**
 * Apply a single {@link ScopeCondition} to `query` as a chained `where`. SAFE: the
 * column name is validated against {@link assertSafeIdentifier} (it is interpolated by
 * Lucid as an identifier); the value is always bound, never interpolated.
 */
function applyCondition(query: ScopeableQuery, c: ScopeCondition): void {
  assertSafeIdentifier(c.field, `scope field "${c.field}"`);
  if (c.op === 'isNull') {
    query.whereNull(c.field);
    return;
  }
  if (c.op === 'isNotNull') {
    query.whereNotNull(c.field);
    return;
  }
  if (c.op === 'in' || c.op === 'nin') {
    const values = Array.isArray(c.value) ? c.value : [c.value];
    // An empty `IN ()` matches nothing; an empty `NOT IN ()` matches everything.
    if (values.length === 0) {
      if (c.op === 'in') query.whereRaw('1 = 0');
      // empty `nin` → no clause (every row matches).
      return;
    }
    if (c.op === 'in') query.whereIn(c.field, values);
    else query.whereNotIn(c.field, values);
    return;
  }
  const token = BINARY_OPS[c.op];
  if (!token) throw new Error(`@adonis-agora/authz: unsupported scope operator: ${c.op}`);
  query.where(c.field, token, c.value);
}

/**
 * Apply a {@link ScopeNode} (condition or boolean group) to `query`. Groups are wrapped
 * in a nested `where`/`orWhere` callback so AND/OR precedence is preserved and the whole
 * scope composes safely with any pre-existing `where`s on the query.
 */
function applyNode(query: ScopeableQuery, node: ScopeNode): void {
  if (node.kind === 'condition') {
    applyCondition(query, node);
    return;
  }
  // An empty AND is the identity (no clause); an empty OR is the zero (always-false).
  if (node.nodes.length === 0) {
    if (node.kind === 'or') query.whereRaw('1 = 0');
    return;
  }
  if (node.kind === 'and') {
    // AND: a wrapped group of chained `where`s.
    query.where((sub) => {
      for (const child of node.nodes) applyNode(sub, child);
    });
    return;
  }
  // OR: each child is its own wrapped `orWhere` group inside an outer group.
  query.where((outer) => {
    node.nodes.forEach((child, index) => {
      if (index === 0) {
        outer.where((sub) => applyNode(sub, child));
      } else {
        outer.orWhere((sub) => applyNode(sub, child));
      }
    });
  });
}

/**
 * Apply an already-resolved {@link ScopeConstraint} to a Lucid query builder. Both the
 * deny-all predicate and the compiled condition tree are emitted INSIDE a single nested
 * `where((sub) => …)` group, so the scope is internally self-consistent and joins the
 * query with a single top-level `AND`.
 *
 * - `allow-all` → adds nothing (every row stays visible);
 * - `deny-all` → adds `WHERE (1 = 0)` (the query returns no rows);
 * - otherwise → the compiled, parameterized condition tree (grouped).
 *
 * ⚠️ **The query MUST NOT already have a top-level `orWhere`.** Because SQL `AND` binds
 * tighter than `OR`, an injected `AND (scope)` attaches only to the LAST `OR` branch —
 * so a deny-all (`1 = 0`) on `where(a).orWhere(b)` compiles to `where a or b and (1 = 0)`
 * and still returns the `a` rows (a leak). Knex cannot retroactively re-group clauses
 * the caller already added, so this helper cannot fix it. Apply the scope FIRST (before
 * adding your own filters), or wrap any caller-side OR inside its own
 * `.where((q) => q.orWhere(…))` group. See {@link accessibleBy} for the full contract.
 *
 * Returns the same builder for chaining. Prefer {@link accessibleBy} for the common
 * case (resolve + apply in one call); use this when you already hold a constraint.
 */
export function applyScopeConstraint<Q>(
  query: Q & ScopeableQuery,
  constraint: ScopeConstraint,
): Q {
  if (constraint.kind === 'all') return query;
  if (constraint.kind === 'none') {
    // Group the deny-all too, so the scope's own clauses are always a single AND-group
    // (self-consistent), matching the grouped AST path below.
    query.where((sub) => sub.whereRaw('1 = 0'));
    return query;
  }
  // Wrap the whole scope in one group so it ANDs with any pre-existing top-level `where`s.
  query.where((sub) => applyNode(sub, constraint));
  return query;
}

/** Options for {@link accessibleBy}. */
export interface AccessibleByOptions {
  /** The action/ability to scope by (default `'viewAny'`). */
  action?: string;
  /** Explicit tenant scope (else resolved from the service's tenant config). */
  scope?: TenantScope;
}

/**
 * Constrain a Lucid query to the rows `user` may access for `action` on `resource`.
 *
 * Resolves the {@link ScopeConstraint} via {@link AuthzService.scope} (super-admin →
 * permission grant → registered filter → deny-all) and applies it to `query`. The
 * filter derives from the SAME authorization data `can`/`hasRole` use — the user's
 * effective roles/permissions for the active tenant.
 *
 * Returns the SAME builder with the scope applied — it does not run the query, so
 * await it once for the constraint and again (or `.exec()`) for the rows:
 *
 * ```ts
 * const scoped = await accessibleBy(Post.query(), service, user, Post)
 * const posts = await scoped.exec()
 * // super-admin: every post; non-privileged: ownership/tenant WHERE injected;
 * // unknown resource: no rows (fail-closed).
 * ```
 *
 * ⚠️ **Contract — the query MUST NOT have a top-level `orWhere`.** The scope is appended
 * with `AND`, and SQL `AND` binds tighter than `OR`, so an `AND (scope)` glued onto a
 * top-level `OR` only constrains the LAST branch — leaking rows, including past a
 * deny-all (`1 = 0`). This helper cannot retroactively re-group clauses the caller
 * already added. Two safe patterns:
 *
 * ```ts
 * // SAFE — apply the scope FIRST, then add only AND-ed filters:
 * const scoped = await accessibleBy(Post.query(), service, user, Post)
 * await scoped.where('published', true) // ANDed: fine
 *
 * // SAFE — wrap any caller-side OR inside its own group, keeping the top level OR-free:
 * const base = Post.query().where((q) => q.where('id', 1).orWhere('id', 2))
 * await accessibleBy(base, service, user, Post) // → (id=1 or id=2) AND (scope)
 *
 * // UNSAFE — top-level OR; the scope only binds to the last branch and leaks:
 * const bad = Post.query().where('id', 1).orWhere('id', 2)
 * await accessibleBy(bad, service, user, Post) // → id=1 OR (id=2 AND scope)  ✗
 * ```
 */
export async function accessibleBy<Q>(
  query: Q & ScopeableQuery,
  service: AuthzService,
  user: unknown,
  resource: ResourceKey,
  options: AccessibleByOptions = {},
): Promise<Q> {
  const constraint = await service.scope(user, resource, {
    ...(options.action !== undefined ? { action: options.action } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
  });
  return applyScopeConstraint(query, constraint);
}
