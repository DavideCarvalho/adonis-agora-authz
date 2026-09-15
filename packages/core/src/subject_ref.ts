/**
 * Polymorphic subject reference. The authz tables NEVER own a users table —
 * subjects (users, teams, service accounts…) are referenced by `(type, id)`,
 * mirroring nestjs-authz's `SubjectRef`.
 */
export interface SubjectRef {
  type: string;
  id: string;
}

/** Accepted shapes a host may hand us when identifying a user. */
export type SubjectRefInput =
  | SubjectRef
  | { type?: string; id: string | number }
  | { id: string | number }
  | string
  | number;

/** A function that maps an arbitrary user object to a {@link SubjectRef}. */
export type ResolveSubjectRef = (user: unknown) => SubjectRefInput | undefined;

/** Roles/permissions resolved for a user. */
export interface SubjectAuthz {
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
 * Normalize any accepted input into a canonical {@link SubjectRef}. Bare
 * string/number ids default their type to `'user'`; objects keep their declared
 * type (or default to `'user'`). Ids are always stringified.
 */
export function normalizeSubjectRef(input: SubjectRefInput): SubjectRef {
  if (typeof input === 'string' || typeof input === 'number') {
    return { type: 'user', id: String(input) };
  }
  const type = 'type' in input && input.type ? input.type : 'user';
  return { type, id: String(input.id) };
}

/**
 * Default mapping from a user object to a {@link SubjectRef}.
 *
 * - a bare string/number → that id (type `user`);
 * - `{ type, id }` → that ref;
 * - `{ id }` → `{ type: 'user', id }`;
 * - anything without an id → `undefined` (unmappable).
 */
export function defaultResolveSubjectRef(user: unknown): SubjectRefInput | undefined {
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
 * here is tolerated but not carried over — {@link identitySubjectRef} always
 * produces the `user` type.
 */
export interface IdentityLike {
  userId?: string | number;
  id?: string | number;
  type?: string;
}

/**
 * Map an authentication identity (e.g. from `@adonis-agora/authkit`) to a
 * {@link SubjectRef}. Wire it as `defineConfig({ resolveSubjectRef: identitySubjectRef })`
 * when pairing authz with an auth provider — the provider owns global roles,
 * authz owns DB-backed fine-grained permissions. Falls back to
 * {@link defaultResolveSubjectRef} when no usable id is present.
 */
export function identitySubjectRef(identity: IdentityLike): SubjectRefInput | undefined {
  const id = identity?.userId ?? identity?.id;
  if (id == null) return defaultResolveSubjectRef(identity);
  return { type: 'user', id: String(id) };
}

/** Tenant scope normalization: missing/empty → global. */
export function normalizeTenant(scope?: TenantScope): string {
  return scope?.tenantId ?? GLOBAL_TENANT;
}
