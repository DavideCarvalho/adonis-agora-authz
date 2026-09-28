import type { SubjectRef, TenantScope } from './subject_ref.js';

/**
 * The minimal query-client surface a store can be scoped to. Mirrors
 * {@link LucidQueryClient} structurally (method-declared, so a real Lucid
 * client — `Database`, a connection, or a transaction's `trx` — satisfies it
 * under `strictFunctionTypes`), without naming Lucid in the neutral contract.
 */
export interface StoreQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[] | Record<string, unknown>): Promise<unknown>;
}

/**
 * Trailing options on every data method. `client` runs that one call's SQL on a
 * query client the host already opened — typically the `db.transaction` client
 * (the Lucid-style per-call escape hatch, e.g. `User.create(data, { client })`).
 * {@link PermissionStore.withClient} binds the same client once for a whole
 * sequence, and a store configured with `resolveClient` does it per call from
 * ambient context. When several are present, the most local wins:
 * `opts.client` → the view's client → the configured resolver → root connection.
 * The memory store ignores `opts` entirely.
 */
export interface StoreOptions {
  client?: StoreQueryClient;
}

/**
 * The source a role assignment is recorded under when none is given. Every assignment made
 * before sources existed — and every `assignRole` without `source` — is a `'manual'` one.
 */
export const DEFAULT_ROLE_SOURCE = 'manual';

/** Longest accepted role-assignment `source` (the Lucid column is `VARCHAR(64)`). */
export const MAX_ROLE_SOURCE_LENGTH = 64;

/**
 * Validate a role-assignment `source` (non-empty, at most {@link MAX_ROLE_SOURCE_LENGTH}
 * characters) and return it, defaulting to {@link DEFAULT_ROLE_SOURCE}. Shared by every store
 * so they reject the same inputs.
 */
export function normalizeRoleSource(source: string | undefined): string {
  if (source === undefined) return DEFAULT_ROLE_SOURCE;
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('@adonis-agora/authz: a role-assignment source must be a non-empty string.');
  }
  if (source.length > MAX_ROLE_SOURCE_LENGTH) {
    throw new Error(
      `@adonis-agora/authz: role-assignment source ${JSON.stringify(source)} is longer than ${MAX_ROLE_SOURCE_LENGTH} characters.`,
    );
  }
  return source;
}

/**
 * The scope of a role assignment: the tenant ({@link TenantScope}) plus the assignment's
 * `source` — who put it there (`'manual'` for the admin UI / API, `'scim'`, `'sso'`, …).
 *
 * The same role held via two sources is two assignments; removing one keeps the role.
 */
export interface RoleAssignmentScope extends TenantScope {
  /**
   * Who owns the assignment. Defaults to {@link DEFAULT_ROLE_SOURCE} (`'manual'`) on
   * `assignRole`. On `removeRole`, omit it to remove the role from EVERY source.
   */
  source?: string;
}

/** One stored role assignment, as returned by {@link PermissionStore.getRoleAssignments}. */
export interface RoleAssignment {
  role: string;
  source: string;
  /** The tenant the assignment is scoped to; `null` for a global assignment. */
  tenantId: string | null;
}

/** Options of {@link PermissionStore.setSubjectRoles}. */
export interface SetSubjectRolesOptions extends StoreOptions {
  /** The source whose assignments are replaced. Default {@link DEFAULT_ROLE_SOURCE}. */
  source?: string;
  /** The tenant whose assignments are replaced (exact match). Default: global. */
  tenantId?: string;
}

/**
 * The DB-backed RBAC store contract — ported from nestjs-authz's
 * `TypeOrmAuthzStore` public API. Implementations are the "thin store" Bouncer
 * abilities consult at check time.
 *
 * Semantics every implementation MUST preserve:
 * - All write methods are idempotent and race-tolerant.
 * - `assignRole` / `removeRole` / `getRolesForSubject` / `getPermissionsForSubject`
 *   are tenant-aware. Direct user-permission grants are tenant-independent.
 * - Tenant visibility: a global request (`''`) sees only global rows; a
 *   tenant request sees global rows AND that tenant's rows. A tenant-scoped
 *   assignment never leaks into an unscoped check.
 * - Role assignments carry a `source` (default `'manual'`). One (subject, role, tenant)
 *   may be held via several sources — one row each; role reads and member counts stay
 *   DISTINCT across sources.
 * - `subjectHasPermission` matches permission NAMES exactly. Wildcard expansion is
 *   the caller's job (it reads `getPermissionsForSubject` and runs the matcher).
 * - Every data method takes a trailing {@link StoreOptions}; the client it
 *   carries (or the one {@link withClient} / the `resolveClient` config bound)
 *   runs the method's SQL. `ensureSchema` is the exception: DDL belongs to the
 *   store's root connection, never to a transaction.
 */
export interface PermissionStore {
  /** Create/upgrade the RBAC tables (no-op for the memory store). */
  ensureSchema(): Promise<void>;

  /** Idempotently create a role by name; returns its id. */
  createRole(name: string, opts?: StoreOptions): Promise<string>;
  /** Idempotently create a permission by name; returns its id. */
  createPermission(name: string, opts?: StoreOptions): Promise<string>;

  /** Grant a permission to a role (creating either by name as needed). */
  givePermissionToRole(
    roleName: string,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void>;
  /** Revoke a permission from a role; no-op when either is absent. */
  revokePermissionFromRole(
    roleName: string,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void>;

  /**
   * Assign a role to a user (optionally tenant-scoped), recorded under `scope.source`
   * (default `'manual'`). Idempotent per (user, role, tenant, source).
   */
  assignRole(
    user: SubjectRef,
    roleName: string,
    scope?: RoleAssignmentScope,
    opts?: StoreOptions,
  ): Promise<void>;
  /**
   * Remove a role assignment matching the exact tenant scope. Without `scope.source` the role
   * is removed from EVERY source (the pre-sources meaning); with it, only that source's
   * assignment goes and the role survives if another source still grants it.
   */
  removeRole(
    user: SubjectRef,
    roleName: string,
    scope?: RoleAssignmentScope,
    opts?: StoreOptions,
  ): Promise<void>;

  /**
   * Replace ONE source's role assignments for a user in ONE tenant scope (exact match; default
   * global) with `roleNames`: missing roles are created and assigned, that source's other
   * assignments are removed. Assignments from other sources and other tenants are untouched —
   * the sync primitive for SSO/SCIM (`setSubjectRoles(user, groups, { source: 'scim' })`) that
   * never clobbers manual grants. Atomic: the Lucid store runs it in one transaction (or joins
   * the client it was given).
   */
  setSubjectRoles(
    user: SubjectRef,
    roleNames: readonly string[],
    options?: SetSubjectRolesOptions,
  ): Promise<void>;

  /**
   * Every role assignment of a user — one entry per (role, source, tenant) — with the same
   * tenant visibility as {@link getRolesForSubject}. `tenantId` is `null` for global rows.
   */
  getRoleAssignments(
    user: SubjectRef,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<RoleAssignment[]>;

  /**
   * Delete a role outright: revokes its permission grants, removes every user
   * assignment, deletes the role row. Idempotent — an unknown name is a no-op.
   * Whether to refuse a role that still has members is the HOST's decision
   * (call {@link countSubjectsForRole} first); the store just deletes.
   */
  deleteRole(name: string, opts?: StoreOptions): Promise<void>;

  /** Grant a permission directly to a user (tenant-independent). */
  giveSubjectPermission(
    user: SubjectRef,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void>;
  /** Revoke a direct user grant (role-derived permissions survive). */
  revokeSubjectPermission(
    user: SubjectRef,
    permissionName: string,
    opts?: StoreOptions,
  ): Promise<void>;

  /** DISTINCT role names for a user, tenant-filtered (a role held via two sources appears once). */
  getRolesForSubject(user: SubjectRef, scope?: TenantScope, opts?: StoreOptions): Promise<string[]>;
  /**
   * Reverse of {@link getRolesForSubject}: every user that holds `role` in the
   * store, tenant-filtered with the SAME visibility rule (a global request sees
   * only global assignments; a tenant request sees global AND that tenant's).
   * Returns `{ type, id }` refs.
   */
  getSubjectsForRole(role: string, scope?: TenantScope, opts?: StoreOptions): Promise<SubjectRef[]>;
  /**
   * Count of distinct users holding `role`, with the same tenant visibility as
   * {@link getSubjectsForRole}. The "N users" KPI of a roles screen, without
   * transferring one ref per member.
   */
  countSubjectsForRole(role: string, scope?: TenantScope, opts?: StoreOptions): Promise<number>;
  /**
   * Every role with its distinct member count in one pass (roles nobody holds
   * count as `0`), for a whole roles matrix. Same tenant visibility as
   * {@link getSubjectsForRole}.
   */
  countSubjectsByRole(scope?: TenantScope, opts?: StoreOptions): Promise<Record<string, number>>;
  /** Effective permission names for a user (role-derived ∪ direct). */
  getPermissionsForSubject(
    user: SubjectRef,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<string[]>;

  /**
   * Exact-name check: does the user hold `permission` via a role (tenant-aware)
   * or a direct grant? Wildcards are NOT expanded here.
   */
  subjectHasPermission(
    user: SubjectRef,
    permission: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<boolean>;

  /** List every role name known to the store (for ace `authz:list`). */
  listRoles(opts?: StoreOptions): Promise<string[]>;
  /** List every permission name known to the store (for ace `authz:list`). */
  listPermissions(opts?: StoreOptions): Promise<string[]>;
  /** List the permission names attached to a role. */
  getRolePermissions(roleName: string, opts?: StoreOptions): Promise<string[]>;

  /**
   * A view of this store whose SQL runs on `client` — the store's transaction
   * seam in one injection point: bind the `db.transaction` client here and
   * every later call on the view joins that transaction, commits or rolls back
   * with it (the Kysely `trx`-is-the-db idiom, without re-plumbing call sites).
   * Guards like "the last administrator cannot be removed" MUST read through
   * the view too: only an in-transaction count sees the not-yet-committed state
   * and stays race-tolerant.
   *
   * The view never runs DDL and never waits on the root connection: ensure the
   * schema (boot auto-create or migrations) BEFORE opening the transaction.
   * The memory store has no client to join and returns `this`.
   */
  withClient(client: StoreQueryClient): PermissionStore;
}
