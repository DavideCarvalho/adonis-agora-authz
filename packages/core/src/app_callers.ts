import app from '@adonisjs/core/services/app';
import { type AppCallerLike, appSubjectRef } from './agora/app_caller.js';
import { AuthzService } from './authz_service.js';
import type { TenantScope } from './subject_ref.js';

/**
 * A calling app as the libs' app-caller seams hand it over: `{ app, capabilities }`
 * (`ctx.agora.caller`) or `{ app, claims: { capabilities } }` (`@adonis-agora/media`'s
 * `identifyAgoraCaller`, `identifySharedSecret`…).
 */
export interface PermitCallerInput {
  app: string;
  capabilities?: readonly string[] | undefined;
  claims?: Record<string, unknown> | undefined;
}

/** Options for {@link permitAuthz}. */
export interface PermitAuthzOptions {
  /** Tenant scope of the check. Default: authz's usual one (none for a service token: global). */
  scope?: TenantScope | undefined;
}

/** The caller as authz sees it: its name and the capabilities its identification carried. */
function toAppCaller(caller: PermitCallerInput): AppCallerLike {
  const fromClaims = caller.claims?.capabilities;
  const capabilities = Array.isArray(caller.capabilities)
    ? caller.capabilities
    : Array.isArray(fromClaims)
      ? fromClaims.filter((c): c is string => typeof c === 'string')
      : [];
  return { app: caller.app, capabilities };
}

/**
 * A `permit` for the libs' app-caller seams (`authorizeAppCaller({ identify, permit })` in
 * `@adonis-agora/media`, and the same seam in the other Agora libs): may this app do `permission`?
 * Asks `authz.can({ type: 'app', id: caller.app }, permission)`, so the app's grants are:
 *
 * - the capabilities its identification carried (an authkit service token's), with the Agora
 *   capability rule (`media:*`);
 * - its roles and permissions in the authz store (`authz.assignRole({ type: 'app', id: 'hub' }, …)`),
 *   `resolveRoles` and `roleGrants`, like any subject: apps without authkit are granted here;
 * - the `superAdmin` hook and the decision provider, which see `{ type: 'app', id }`.
 *
 * ```ts
 * import { permitAuthz } from '@adonis-agora/authz'
 * authorizeAppCaller({ identify: identifyAgoraCaller(), permit: permitAuthz() })
 * ```
 */
export function permitAuthz(
  options: PermitAuthzOptions = {},
): (caller: PermitCallerInput, permission: string) => Promise<boolean> {
  return async (caller, permission) => {
    if (typeof caller?.app !== 'string' || caller.app === '') return false;
    const authz = await app.container.make(AuthzService);
    const subject = toAppCaller(caller);
    const decision = await authz.checkForRef(appSubjectRef(subject.app), permission, {
      user: subject,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    });
    return decision.allowed;
  };
}
