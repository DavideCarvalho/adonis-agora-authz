import { CompiledPermissions } from './permission_matcher.js';
import type { PermissionStore } from './store.js';
import type { SubjectRef, TenantScope } from './subject_ref.js';

/**
 * Memo key for the (user, tenant) pair. JSON.stringify rather than a joined
 * string: host-controlled segments may contain any visible separator, and a
 * raw NUL would make this file unreadable to git diff (same rule as
 * `compositeKey` in stores/memory.ts).
 */
const key = (user: SubjectRef, scope?: TenantScope): string =>
  JSON.stringify([user.type, user.id, scope?.tenantId ?? '']);

/**
 * Per-request memoization of the user's effective permissions AND effective
 * roles, ported from nestjs-authz's `PermissionCache`. At most one fetch per
 * (user, tenant) per request per dimension, so all checks in one request share
 * a single read (kills the N+1) — including the role read `can()` does before
 * it ever consults permissions. The pending promise is stored so concurrent
 * checks dedupe; a rejected read is dropped so the next check retries it.
 * Snapshot semantics: the cache never invalidates, so every check in a request
 * decides against the same state, and a grant or revocation made mid-request
 * applies from the next request.
 *
 * `resolveRoles` is the role function the {@link AuthzService} injects (context
 * ∪ app resolver ∪ store). A cache built with just a store falls back to
 * `store.getRolesForSubject`, so a standalone cache still memoizes the store read.
 */
export class PermissionCache {
  private cache = new Map<string, Promise<CompiledPermissions>>();
  private roleCache = new Map<string, Promise<string[]>>();
  private matcherCache = new WeakMap<
    (roles: readonly string[]) => readonly string[],
    Map<string, Promise<CompiledPermissions>>
  >();

  constructor(
    private readonly store: PermissionStore,
    private readonly resolveRoles?: (user: SubjectRef, scope?: TenantScope) => Promise<string[]>,
  ) {}

  /** The user's effective roles, memoized — the same union the service computes. */
  getRoles(user: SubjectRef, scope?: TenantScope): Promise<string[]> {
    const k = key(user, scope);
    let pending = this.roleCache.get(k);
    if (!pending) {
      pending = this.resolveRoles
        ? this.resolveRoles(user, scope)
        : this.store.getRolesForSubject(user, scope);
      this.roleCache.set(k, pending);
      pending.catch(() => this.roleCache.delete(k));
    }
    return pending;
  }

  /** The user's full granted permission set (role-derived ∪ direct), memoized. */
  async getPermissions(user: SubjectRef, scope?: TenantScope): Promise<ReadonlySet<string>> {
    return (await this.compiledPermissions(user, scope)).granted;
  }

  private compiledPermissions(user: SubjectRef, scope?: TenantScope): Promise<CompiledPermissions> {
    const k = key(user, scope);
    let pending = this.cache.get(k);
    if (!pending) {
      pending = this.store
        .getPermissionsForSubject(user, scope)
        .then((perms) => new CompiledPermissions(perms));
      this.cache.set(k, pending);
      pending.catch(() => this.cache.delete(k));
    }
    return pending;
  }

  /** Wildcard-aware: does the user's granted set satisfy `ability`? */
  async satisfies(user: SubjectRef, ability: string, scope?: TenantScope): Promise<boolean> {
    return (await this.compiledPermissions(user, scope)).satisfies(ability);
  }

  /**
   * The user's granted set ∪ `grantsForRoles(effective roles)`, compiled once per
   * (user, tenant) — what {@link AuthzService.can} matches against. Memoized per
   * `grantsForRoles` function, so pass a stable reference.
   */
  matcher(
    user: SubjectRef,
    scope: TenantScope | undefined,
    grantsForRoles: (roles: readonly string[]) => readonly string[],
  ): Promise<CompiledPermissions> {
    let byKey = this.matcherCache.get(grantsForRoles);
    if (!byKey) {
      byKey = new Map();
      this.matcherCache.set(grantsForRoles, byKey);
    }
    const memo = byKey;
    const k = key(user, scope);
    let pending = memo.get(k);
    if (!pending) {
      // Sequential, roles first: the role read may run the host's `resolveRoles` seam,
      // which can share a connection or transaction with the store.
      pending = this.getRoles(user, scope).then(async (roles) => {
        const compiled = await this.compiledPermissions(user, scope);
        const extra = grantsForRoles(roles);
        return extra.length === 0
          ? compiled
          : new CompiledPermissions([...compiled.granted, ...extra]);
      });
      memo.set(k, pending);
      pending.catch(() => memo.delete(k));
    }
    return pending;
  }
}
