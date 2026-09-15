import type { SubjectRef, TenantScope } from './subject_ref.js';

/**
 * Conservative identifier allowlist for any column name interpolated into a query
 * by the Lucid adapter — policy-supplied scope `field`s. Values are always bound,
 * never concatenated; only identifiers are validated against this.
 *
 * The identifier is one or more dot-separated segments (`column` or
 * `table.column`), where EACH segment must be a real identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`). This rejects malformed-but-not-injectable inputs
 * like `a.`, `.a`, or `a..b` (empty/missing segments) up front rather than letting
 * them through as broken SQL.
 */
export const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Validate a column identifier against {@link SAFE_IDENTIFIER}, throwing on anything
 * containing quotes, whitespace, or other unsafe characters. A qualified
 * `table.column` is allowed (dot-separated segments), so a scope can target a joined
 * column — but every segment must be a non-empty identifier, so a trailing/leading or
 * doubled dot (`a.`, `.a`, `a..b`) is rejected. Single source of the injection guard
 * for the scope adapter.
 */
export function assertSafeIdentifier(value: string, what: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `@adonis-agora/authz: unsafe ${what}: ${JSON.stringify(value)}. Identifiers must match /^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$/ (dot-separated segments of letters, digits, underscore; each segment non-empty and not starting with a digit). This blocks injection via configured names.`,
    );
  }
}

/**
 * ORM-neutral query-scope constraint (the `accessibleBy` / Pundit `policy_scope` /
 * Cerbos `PlanResources` concept). Where {@link AuthzService.can} decides yes/no for a
 * SINGLE resource, a query scope produces a constraint that filters a COLLECTION to the
 * rows the user may access — applied at the DB layer instead of over-fetch-then-filter.
 *
 * The representation is a small, pure-data condition AST (no callbacks, fully
 * serializable) so the Lucid adapter can walk it and emit a parameterized,
 * identifier-safe `WHERE`. Two terminal verdicts bracket the AST and keep it aligned
 * with the service's deny-by-default + super-admin semantics:
 *
 * - {@link ScopeAll} (`allow-all`) — the user sees every row (super-admin, a global
 *   super-admin role, or a permission grant for the scope ability). No `WHERE` added.
 * - {@link ScopeNone} (`deny-all`) — the user sees no rows (anonymous, or an unknown
 *   resource with no registered scope). The adapter emits an always-false predicate.
 */
export type ScopeConstraint = ScopeAll | ScopeNone | ScopeNode;

/** Terminal: the user may access every row — no filter is applied. */
export interface ScopeAll {
  kind: 'all';
}

/** Terminal: the user may access no rows — an always-false predicate is applied. */
export interface ScopeNone {
  kind: 'none';
}

/** A non-terminal constraint: a single condition or a boolean group of them. */
export type ScopeNode = ScopeCondition | ScopeGroup;

/** Comparison operators a {@link ScopeCondition} may use. ORM-neutral; the adapter maps them. */
export type ScopeOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'isNull'
  | 'isNotNull';

/**
 * A leaf condition: `field <op> value`. `field` names a COLUMN on the scoped model
 * (validated as a safe identifier by the adapter). `value` is bound as a parameter
 * (never interpolated). `isNull`/`isNotNull` ignore `value`.
 */
export interface ScopeCondition {
  kind: 'condition';
  field: string;
  op: ScopeOperator;
  value?: unknown;
}

/** A boolean group: AND/OR over child nodes. An empty group is the group's identity. */
export interface ScopeGroup {
  kind: 'and' | 'or';
  nodes: ScopeNode[];
}

/** The allow-all terminal (super-admin / permission grant). */
export const scopeAll: ScopeAll = { kind: 'all' };

/** The deny-all terminal (anonymous / no access / unknown resource). */
export const scopeNone: ScopeNone = { kind: 'none' };

/** Build a leaf `field <op> value` condition. */
export function where(field: string, op: ScopeOperator, value?: unknown): ScopeCondition {
  return op === 'isNull' || op === 'isNotNull'
    ? { kind: 'condition', field, op }
    : { kind: 'condition', field, op, value };
}

/** Shorthand for the common `field = value` (equality) condition. */
export function eq(field: string, value: unknown): ScopeCondition {
  return { kind: 'condition', field, op: 'eq', value };
}

/** Shorthand for `field IN values`. */
export function whereIn(field: string, values: unknown[]): ScopeCondition {
  return { kind: 'condition', field, op: 'in', value: values };
}

/** Combine nodes with AND. A single node is returned as-is; empty → allow-all. */
export function and(...nodes: ScopeNode[]): ScopeConstraint {
  if (nodes.length === 0) return scopeAll;
  if (nodes.length === 1) return nodes[0] as ScopeNode;
  return { kind: 'and', nodes };
}

/** Combine nodes with OR. A single node is returned as-is; empty → deny-all. */
export function or(...nodes: ScopeNode[]): ScopeConstraint {
  if (nodes.length === 0) return scopeNone;
  if (nodes.length === 1) return nodes[0] as ScopeNode;
  return { kind: 'or', nodes };
}

/**
 * What a registered scope filter may return:
 * - a {@link ScopeConstraint} (terminal or AST),
 * - `true` → allow-all (sugar for {@link scopeAll}),
 * - `false`/`null`/`undefined` → deny-all (sugar for {@link scopeNone}).
 *
 * May be async.
 */
export type ScopeResult = ScopeConstraint | boolean | null | undefined;

/**
 * Context handed to a registered {@link ScopeFilter}: the resolved {@link SubjectRef},
 * the action/ability being scoped, the user's effective roles and permissions
 * (already tenant-filtered + wildcard-aware via the store), and the active tenant.
 * Everything a filter needs to derive its `where` from the SAME authorization data
 * `can`/`hasRole` consult — without re-querying the store.
 */
export interface ScopeFilterContext {
  /** The resolved user reference (`{ type, id }`). */
  user: SubjectRef;
  /** The action/ability being scoped (e.g. `viewAny`, `posts.read`). */
  action: string;
  /** The user's effective permission names for the active tenant (role-derived ∪ direct). */
  permissions: string[];
  /** The user's effective role names for the active tenant. */
  roles: string[];
  /** The active tenant scope (`undefined` → global). */
  tenant: TenantScope | undefined;
}

/**
 * A registered scope filter for a resource. Mirrors Pundit's `Scope#resolve`: given
 * the {@link ScopeFilterContext}, return the constraint that filters the resource's
 * collection to the accessible rows. Registered per resource key via
 * {@link ScopeRegistry.register}.
 */
export type ScopeFilter = (ctx: ScopeFilterContext) => ScopeResult | Promise<ScopeResult>;

/** Normalize a {@link ScopeResult} (incl. boolean/nullish sugar) into a {@link ScopeConstraint}. */
export function normalizeScope(result: ScopeResult): ScopeConstraint {
  if (result == null) return scopeNone;
  if (result === true) return scopeAll;
  if (result === false) return scopeNone;
  return result;
}

/**
 * A resource key: a Lucid model class (matched by reference) or a string name. Model
 * classes are the common case (`accessibleBy(Post.query(), ...)` keys on `Post`); a
 * string lets a host register a scope without importing the model.
 */
export type ResourceKey = string | (new (...args: never[]) => unknown);

/**
 * The per-app registry of resource → {@link ScopeFilter}. Fail-closed: an unregistered
 * resource resolves to {@link scopeNone} (deny-all), matching how authz treats an
 * unknown permission. Keyed by model-class reference or string name.
 */
export class ScopeRegistry {
  private readonly byClass = new Map<new (...args: never[]) => unknown, ScopeFilter>();
  private readonly byName = new Map<string, ScopeFilter>();

  /** Register a scope filter for `resource` (model class or string name). */
  register(resource: ResourceKey, filter: ScopeFilter): this {
    if (typeof resource === 'string') this.byName.set(resource, filter);
    else this.byClass.set(resource, filter);
    return this;
  }

  /** The registered filter for `resource`, or `undefined` when none is registered. */
  resolve(resource: ResourceKey): ScopeFilter | undefined {
    if (typeof resource === 'string') return this.byName.get(resource);
    return this.byClass.get(resource);
  }

  /** True when a scope filter is registered for `resource`. */
  has(resource: ResourceKey): boolean {
    return this.resolve(resource) !== undefined;
  }
}
