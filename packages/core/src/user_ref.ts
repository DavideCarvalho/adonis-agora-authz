/**
 * Polymorphic user reference. The authz tables NEVER own a users table — users
 * are referenced by `(type, id)`, mirroring nestjs-authz's `UserRef`.
 */
export interface UserRef {
  type: string;
  id: string;
}

/** Accepted shapes a host may hand us when identifying a user. */
export type UserRefInput =
  | UserRef
  | { type?: string; id: string | number }
  | { id: string | number }
  | string
  | number;

/** A function that maps an arbitrary user object to a {@link UserRef}. */
export type ResolveUserRef = (user: unknown) => UserRefInput | undefined;

/** Roles/permissions resolved for a user. */
export interface UserAuthz {
  roles: string[];
  permissions: string[];
}

/** Tenant scope. `tenantId` omitted (or `''`) means the global scope. */
export interface TenantScope {
  tenantId?: string;
}

/** The empty-string sentinel for "no tenant" (the global scope). */
export const GLOBAL_TENANT = '';

/**
 * Normalize any accepted input into a canonical {@link UserRef}. Bare
 * string/number ids default their type to `'user'`; objects keep their declared
 * type (or default to `'user'`). Ids are always stringified.
 */
export function normalizeUserRef(input: UserRefInput): UserRef {
  if (typeof input === 'string' || typeof input === 'number') {
    return { type: 'user', id: String(input) };
  }
  const type = 'type' in input && input.type ? input.type : 'user';
  return { type, id: String(input.id) };
}

/**
 * Default mapping from a user object to a {@link UserRef}.
 *
 * - a bare string/number → that id (type `user`);
 * - `{ type, id }` → that ref;
 * - `{ id }` → `{ type: 'user', id }`;
 * - anything without an id → `undefined` (unmappable).
 */
export function defaultResolveUserRef(user: unknown): UserRefInput | undefined {
  if (user == null) return undefined;
  if (typeof user === 'string' || typeof user === 'number') return user;
  if (typeof user === 'object') {
    const candidate = user as { id?: unknown; type?: unknown };
    if (candidate.id == null) return undefined;
    const id = candidate.id;
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    if (typeof candidate.type === 'string' && candidate.type) {
      return { type: candidate.type, id };
    }
    return { id };
  }
  return undefined;
}

/**
 * A minimal, structurally-typed authentication identity. Deliberately NOT
 * imported from any auth package: it just describes the shape we read. AuthKit's
 * `Identity` has `userId`; a plain `id` is accepted as an alternative. A `type`
 * here is tolerated but not carried over — {@link identityUserRef} always
 * produces the `user` type.
 */
export interface IdentityLike {
  userId?: string | number;
  id?: string | number;
  type?: string;
}

/**
 * Map an authentication identity (e.g. from `@adonis-agora/authkit`) to a
 * {@link UserRef}. Wire it as `defineConfig({ resolveUserRef: identityUserRef })`
 * when pairing authz with an auth provider — the provider owns global roles,
 * authz owns DB-backed fine-grained permissions. Falls back to
 * {@link defaultResolveUserRef} when no usable id is present.
 */
export function identityUserRef(identity: IdentityLike): UserRefInput | undefined {
  const id = identity?.userId ?? identity?.id;
  if (id == null) return defaultResolveUserRef(identity);
  return { type: 'user', id: String(id) };
}

/** Tenant scope normalization: missing/empty → global. */
export function normalizeTenant(scope?: TenantScope): string {
  return scope?.tenantId ?? GLOBAL_TENANT;
}
