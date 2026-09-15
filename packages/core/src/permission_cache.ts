import { permissionSatisfied } from './permission_matcher.js';
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
 * checks dedupe. Snapshot semantics: the cache never invalidates, so every
 * check in a request decides against the same state.
 *
 * `resolveRoles` is the role function the {@link AuthzService} injects (context
 * ∪ app resolver ∪ store). A cache built with just a store falls back to
 * `store.getRolesForSubject`, so a standalone cache still memoizes the store read.
 */
export class PermissionCache {
  private cache = new Map<string, Promise<ReadonlySet<string>>>();
  private roleCache = new Map<string, Promise<string[]>>();

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
    }
    return pending;
  }

  /** The user's full granted permission set (role-derived ∪ direct), memoized. */
  getPermissions(user: SubjectRef, scope?: TenantScope): Promise<ReadonlySet<string>> {
    const k = key(user, scope);
    let pending = this.cache.get(k);
    if (!pending) {
      pending = this.store.getPermissionsForSubject(user, scope).then((perms) => new Set(perms));
      this.cache.set(k, pending);
    }
    return pending;
  }

  /** Wildcard-aware: does the user's granted set satisfy `ability`? */
  async satisfies(user: SubjectRef, ability: string, scope?: TenantScope): Promise<boolean> {
    const set = await this.getPermissions(user, scope);
    return permissionSatisfied(set, ability);
  }
}
