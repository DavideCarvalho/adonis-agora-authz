/**
 * Structural, dependency-free bridge to the Agora runtime context.
 *
 * The Agora context library publishes a READ accessor on a well-known global
 * symbol slot. We never import that package — we read the slot structurally, so
 * authz has zero hard dependency on it. When the slot is absent (authz used
 * standalone), every reader degrades to `undefined` and default behavior is
 * unchanged.
 */

/** The symbol slot the Agora context library writes its read accessor into. */
export const AGORA_CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/**
 * The shape we read from the accessor slot. Deliberately minimal and tolerant:
 * fields are optional. `get()` (no argument) returns the whole active store — the
 * one form every `@adonis-agora/context` version has always implemented, so we
 * read it and index the key ourselves rather than trusting `get(key)`, which only
 * newer context versions honour.
 *
 * `@adonis-agora/context`'s real accessor (`packages/core/src/accessor.ts`) publishes
 * `traceId`, `tenantId`, and `userRef` as METHODS — calling them returns the active
 * value, or `undefined` outside a request/job. They are NOT plain properties; reading
 * them as values (the mistake this file used to make for `tenantId`) makes the field a
 * truthy function reference instead of the data it holds.
 */
export interface AgoraContextAccessor {
  traceId?: () => string | undefined;
  tenantId?: () => string | undefined;
  userRef?: () => { type?: string; id?: string | number } | undefined;
  /** Read the whole active context store (structural). */
  get?: () => unknown;
}

/** Read the active Agora context accessor from the global slot, if present. */
export function readContextAccessor(): AgoraContextAccessor | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR];
  if (slot == null || typeof slot !== 'object') return undefined;
  return slot as AgoraContextAccessor;
}

/**
 * Call an accessor method safely: tolerates the method being absent (a partial/mocked
 * accessor, or a slot that isn't the real `@adonis-agora/context` implementation) and
 * tolerates it throwing. Degrades to `undefined` either way — this package never
 * fabricates identity from a broken context, it just leaves the field empty.
 */
function readMethod<T>(fn: unknown): T | undefined {
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as () => T | undefined)();
  } catch {
    return undefined;
  }
}

/** The active tenant id from the Agora context, or `undefined` when unset. */
export function tenantFromContext(): string | undefined {
  const accessor = readContextAccessor();
  const tenantId = readMethod<string>(accessor?.tenantId);
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined;
}

/**
 * The active caller's `userRef` from the Agora context, or `undefined` outside a
 * context / when the accessor slot is absent.
 */
export function userRefFromContext(): { type?: string; id?: string | number } | undefined {
  const accessor = readContextAccessor();
  return readMethod(accessor?.userRef);
}

/**
 * Read a value from the active Agora context store, tolerant of a missing slot or
 * accessor.
 *
 * We read the WHOLE store via `get()` and index the key here, instead of calling
 * `get(key)`. The context lib's accessor historically implemented only the no-arg
 * `get()`; a `get(key)` call on those versions ignored the argument and returned
 * the whole store, so `readContextValue('globalRoles')` got an object, its
 * `Array.isArray` check failed, and every global-role permission silently denied.
 * Reading `get()` and indexing locally works against every context version.
 */
export function readContextValue(key: string): unknown {
  const accessor = readContextAccessor();
  if (typeof accessor?.get !== 'function') return undefined;
  try {
    const store = accessor.get();
    if (store == null || typeof store !== 'object') return undefined;
    return (store as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The user's global roles as written by authkit into the context store under
 * the `globalRoles` key. Returns `[]` when absent or malformed.
 */
export function globalRolesFromContext(): string[] {
  const value = readContextValue('globalRoles');
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is string => typeof r === 'string');
}
