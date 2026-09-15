import { AuthzService } from '../src/authz_service.js';
import { PermissionCache } from '../src/permission_cache.js';
import type { PermissionStore, StoreQueryClient } from '../src/store.js';
import { getBootedApp } from './booted_app.js';

/**
 * The surface of {@link AuthzService} this singleton forwards — everything an app reaches for
 * from routes, commands, abilities, models or config: the async decision API, the `store` (every
 * method of it is async, so it forwards lazily too) and `createCache()`. Typed with `Pick` so the
 * forwards stay in lockstep with the class: a signature change stops compiling instead of drifting.
 *
 * Omitted on purpose: the SYNC members `refOf`, `currentScope` and `scopes`. They cannot be
 * forwarded without resolving the container synchronously; resolve {@link AuthzService} from the
 * container when you need one of them (the mixin does that internally).
 */
export type AuthzQueryService = Pick<
  AuthzService,
  | 'can'
  | 'scope'
  | 'hasRole'
  | 'hasAnyRole'
  | 'effectiveRoles'
  | 'effectivePermissions'
  | 'effectiveRolesForRef'
  | 'subjectsWithRole'
  | 'createCache'
> & { readonly store: PermissionStore };

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
export const resolveAuthzService = (): Promise<AuthzService> => {
  servicePromise ??= getBootedApp().container.make(AuthzService);
  return servicePromise;
};

/**
 * A lazy {@link PermissionStore}: every method forwards to the resolved service's store. The one
 * sync member, `withClient`, returns another lazy view bound to the given client, so a transaction
 * seam works through the singleton exactly like through the class.
 */
function lazyStore(pick: () => Promise<PermissionStore>): PermissionStore {
  const forward =
    <K extends keyof PermissionStore>(method: K) =>
    async (...args: Parameters<Extract<PermissionStore[K], (...a: never[]) => unknown>>) =>
      ((await pick())[method] as unknown as (...a: typeof args) => Promise<unknown>)(...args);

  return {
    ensureSchema: forward('ensureSchema'),
    createRole: forward('createRole'),
    createPermission: forward('createPermission'),
    givePermissionToRole: forward('givePermissionToRole'),
    revokePermissionFromRole: forward('revokePermissionFromRole'),
    assignRole: forward('assignRole'),
    removeRole: forward('removeRole'),
    deleteRole: forward('deleteRole'),
    giveSubjectPermission: forward('giveSubjectPermission'),
    revokeSubjectPermission: forward('revokeSubjectPermission'),
    getRolesForSubject: forward('getRolesForSubject'),
    getSubjectsForRole: forward('getSubjectsForRole'),
    countSubjectsForRole: forward('countSubjectsForRole'),
    countSubjectsByRole: forward('countSubjectsByRole'),
    getPermissionsForSubject: forward('getPermissionsForSubject'),
    subjectHasPermission: forward('subjectHasPermission'),
    listRoles: forward('listRoles'),
    listPermissions: forward('listPermissions'),
    getRolePermissions: forward('getRolePermissions'),
    withClient: (client: StoreQueryClient) =>
      lazyStore(async () => (await pick()).withClient(client)),
  } as PermissionStore;
}

const store = lazyStore(async () => (await resolveAuthzService()).store);

/**
 * The `@adonis-agora/authz` service singleton — a lazy, container-backed {@link AuthzService}.
 * Import it wherever the service is needed instead of hand-rolling
 * `await app.container.make(AuthzService)` — routes, commands, abilities, models, and config
 * (where the container does not exist yet at import time):
 *
 * ```ts
 * import authz from '@adonis-agora/authz/services/main'
 *
 * await authz.can(user, 'posts.edit')
 * await authz.store.assignRole({ type: 'user', id: '42' }, 'editor')
 * const cache = authz.createCache()
 * ```
 */
// `async` forwards so a synchronous failure in `resolve()` (e.g. the provider not yet registered)
// surfaces as a rejected promise, not a sync throw — these methods are typed as returning promises.
const service: AuthzQueryService = {
  can: async (...args) => (await resolveAuthzService()).can(...args),
  scope: async (...args) => (await resolveAuthzService()).scope(...args),
  hasRole: async (...args) => (await resolveAuthzService()).hasRole(...args),
  hasAnyRole: async (...args) => (await resolveAuthzService()).hasAnyRole(...args),
  effectiveRoles: async (...args) => (await resolveAuthzService()).effectiveRoles(...args),
  effectivePermissions: async (...args) =>
    (await resolveAuthzService()).effectivePermissions(...args),
  effectiveRolesForRef: async (...args) =>
    (await resolveAuthzService()).effectiveRolesForRef(...args),
  subjectsWithRole: async (...args) => (await resolveAuthzService()).subjectsWithRole(...args),
  store,
  // Sync by contract; the cache memoizes PROMISES, so a lazily-resolved roles source is fine.
  createCache: () =>
    new PermissionCache(store, async (ref, tenant) =>
      (await resolveAuthzService()).effectiveRolesForRef(ref, tenant),
    ),
};

export default service;
