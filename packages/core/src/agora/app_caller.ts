/**
 * Apps as subjects. Another app calling this one (`ctx.agora.caller`, set by
 * `@adonis-agora/authkit-client` from a verified service token) is the subject
 * `{ type: 'app', id: <its name> }`. Its permissions are:
 *
 * - the capabilities its token carries (granted on the Hub with `authkit:client grant-app`),
 *   matched with the Agora capability rule ({@link capabilityAllows});
 * - whatever the store, `resolveRoles` and `roleGrants` give that subject, like any other.
 *
 * Read structurally: authz never imports authkit.
 */
import { HttpContext } from '@adonisjs/core/http';
import type { SubjectRef } from '../subject_ref.js';

/** The subject type of an app calling this one. */
export const APP_SUBJECT_TYPE = 'app';

/** The shape of `ctx.agora.caller` authz reads: the app's name and its token's capabilities. */
export interface AppCallerLike {
  app: string;
  capabilities?: readonly string[] | undefined;
}

/** The subject of the app named `app`: `{ type: 'app', id: app }`. */
export function appSubjectRef(app: string): SubjectRef {
  return { type: APP_SUBJECT_TYPE, id: app };
}

/**
 * `true` for an app caller (`ctx.agora.caller`, or anything with a string `app` and no `id`).
 * A model with an `id` is never taken for one.
 */
export function isAppCaller(value: unknown): value is AppCallerLike {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { app?: unknown; id?: unknown };
  return typeof candidate.app === 'string' && candidate.app !== '' && candidate.id == null;
}

/** The app calling in this request (`ctx.agora.caller`), or `undefined`. */
export function appCallerOf(ctx: unknown): AppCallerLike | undefined {
  const caller = (ctx as { agora?: { caller?: unknown } } | null | undefined)?.agora?.caller;
  return isAppCaller(caller) ? caller : undefined;
}

/** The current request's app caller, when the app enables async local storage. */
function requestAppCaller(): AppCallerLike | undefined {
  try {
    return appCallerOf(HttpContext.get());
  } catch {
    return undefined;
  }
}

/**
 * The capabilities `ref` holds through a service token: those of `subject` when it IS the
 * caller object (`authz.can(ctx.agora.caller, …)`), else those of the current request's caller
 * when it is the same app. `[]` for any other subject.
 */
export function appCapabilitiesFor(ref: SubjectRef, subject: unknown): string[] {
  if (ref.type !== APP_SUBJECT_TYPE) return [];
  const caller = isAppCaller(subject) ? subject : requestAppCaller();
  if (caller === undefined || caller.app !== ref.id) return [];
  return Array.isArray(caller.capabilities)
    ? caller.capabilities.filter((c): c is string => typeof c === 'string' && c !== '')
    : [];
}

/**
 * `true` when the granted capability `granted` covers `required` (the Agora-wide rule): segments
 * split on `:`, a `*` segment matches exactly one segment, and a LAST `*` matches zero or more
 * further segments (`media:*` covers `media` and `media:objects:read`; `*` covers everything).
 */
export function capabilityAllows(granted: string, required: string): boolean {
  const have = granted.split(':');
  const want = required.split(':');
  for (let i = 0; i < have.length; i++) {
    const segment = have[i];
    if (segment === '*' && i === have.length - 1) return true;
    if (i >= want.length) return false;
    if (segment !== '*' && segment !== want[i]) return false;
  }
  return have.length === want.length;
}
