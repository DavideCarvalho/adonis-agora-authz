import { AuthzService } from '../src/authz_service.js';
import { getBootedApp } from './booted_app.js';

/**
 * The async authorization-query surface of {@link AuthzService} this service singleton forwards.
 * Typed with `Pick` so the forwards below stay in lockstep with the class: if a method's signature
 * changes, the delegating object stops compiling instead of drifting. The sync members
 * (`store`, `scopes`, `createCache`) are intentionally omitted — they cannot be exposed without
 * resolving the container synchronously, and a config-time consumer (e.g. the agent tool authorizer)
 * only needs the async decision API. Resolve {@link AuthzService} directly for the rest.
 */
export type AuthzQueryService = Pick<
  AuthzService,
  | 'can'
  | 'scope'
  | 'hasRole'
  | 'hasAnyRole'
  | 'effectiveRoles'
  | 'effectivePermissions'
  | 'subjectsWithRole'
>;

/**
 * Resolve the container-bound {@link AuthzService} ONCE and reuse it. Resolution is deferred to the
 * first method call (not at import), so importing this module from `config/*` is safe: config loads
 * DURING boot, before the container bindings exist. The app is read from the provider-captured
 * booted instance ({@link getBootedApp}) rather than `@adonisjs/core/services/app` — see
 * {@link ./booted_app.js} for why that import is unreliable under pnpm. By the time any forwarded
 * method runs (request / agent time) the provider has registered and the `AuthzService` singleton
 * is resolvable.
 */
let servicePromise: Promise<AuthzService> | undefined;
const resolve = (): Promise<AuthzService> => {
  servicePromise ??= getBootedApp().container.make(AuthzService);
  return servicePromise;
};

/**
 * The `@adonis-agora/authz` service singleton — a lazy, container-backed {@link AuthzService}.
 * Import it wherever a resolved `AuthzService` is needed without hand-rolling
 * `await app.container.make(AuthzService)`, including at config-load time:
 *
 * ```ts
 * import authz from '@adonis-agora/authz/services/main'
 * import { authzToolAuthorizer } from '@adonis-agora/agent/authz'
 *
 * export default defineConfig({
 *   authorizer: authzToolAuthorizer({ authz }),
 * })
 * ```
 */
// `async` forwards so a synchronous failure in `resolve()` (e.g. the provider not yet registered)
// surfaces as a rejected promise, not a sync throw — these methods are typed as returning promises.
const service: AuthzQueryService = {
  can: async (...args) => (await resolve()).can(...args),
  scope: async (...args) => (await resolve()).scope(...args),
  hasRole: async (...args) => (await resolve()).hasRole(...args),
  hasAnyRole: async (...args) => (await resolve()).hasAnyRole(...args),
  effectiveRoles: async (...args) => (await resolve()).effectiveRoles(...args),
  effectivePermissions: async (...args) => (await resolve()).effectivePermissions(...args),
  subjectsWithRole: async (...args) => (await resolve()).subjectsWithRole(...args),
};

export default service;
