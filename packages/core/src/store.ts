import type { TenantScope, UserRef } from './user_ref.js';

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
 * The DB-backed RBAC store contract — ported from nestjs-authz's
 * `TypeOrmAuthzStore` public API. Implementations are the "thin store" Bouncer
 * abilities consult at check time.
 *
 * Semantics every implementation MUST preserve:
 * - All write methods are idempotent and race-tolerant.
 * - `assignRole` / `removeRole` / `getRolesForUser` / `getPermissionsForUser`
 *   are tenant-aware. Direct user-permission grants are tenant-independent.
 * - Tenant visibility: a global request (`''`) sees only global rows; a
 *   tenant request sees global rows AND that tenant's rows. A tenant-scoped
 *   assignment never leaks into an unscoped check.
 * - `userHasPermission` matches permission NAMES exactly. Wildcard expansion is
 *   the caller's job (it reads `getPermissionsForUser` and runs the matcher).
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

  /** Assign a role to a user (optionally tenant-scoped). */
  assignRole(
    user: UserRef,
    roleName: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<void>;
  /** Remove a role assignment matching the exact tenant scope. */
  removeRole(
    user: UserRef,
    roleName: string,
    scope?: TenantScope,
    opts?: StoreOptions,
  ): Promise<void>;

  /**
   * Delete a role outright: revokes its permission grants, removes every user
   * assignment, deletes the role row. Idempotent — an unknown name is a no-op.
   * Whether to refuse a role that still has members is the HOST's decision
   * (call {@link countUsersForRole} first); the store just deletes.
   */
  deleteRole(name: string, opts?: StoreOptions): Promise<void>;

  /** Grant a permission directly to a user (tenant-independent). */
  giveUserPermission(user: UserRef, permissionName: string, opts?: StoreOptions): Promise<void>;
  /** Revoke a direct user grant (role-derived permissions survive). */
  revokeUserPermission(user: UserRef, permissionName: string, opts?: StoreOptions): Promise<void>;

  /** Role names for a user, tenant-filtered. */
  getRolesForUser(user: UserRef, scope?: TenantScope, opts?: StoreOptions): Promise<string[]>;
  /**
   * Reverse of {@link getRolesForUser}: every user that holds `role` in the
   * store, tenant-filtered with the SAME visibility rule (a global request sees
   * only global assignments; a tenant request sees global AND that tenant's).
   * Returns `{ type, id }` refs.
   */
  getUsersForRole(role: string, scope?: TenantScope, opts?: StoreOptions): Promise<UserRef[]>;
  /**
   * Count of distinct users holding `role`, with the same tenant visibility as
   * {@link getUsersForRole}. The "N users" KPI of a roles screen, without
   * transferring one ref per member.
   */
  countUsersForRole(role: string, scope?: TenantScope, opts?: StoreOptions): Promise<number>;
  /**
   * Every role with its distinct member count in one pass (roles nobody holds
   * count as `0`), for a whole roles matrix. Same tenant visibility as
   * {@link getUsersForRole}.
   */
  countUsersByRole(scope?: TenantScope, opts?: StoreOptions): Promise<Record<string, number>>;
  /** Effective permission names for a user (role-derived ∪ direct). */
  getPermissionsForUser(user: UserRef, scope?: TenantScope, opts?: StoreOptions): Promise<string[]>;

  /**
   * Exact-name check: does the user hold `permission` via a role (tenant-aware)
   * or a direct grant? Wildcards are NOT expanded here.
   */
  userHasPermission(
    user: UserRef,
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
