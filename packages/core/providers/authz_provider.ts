import type { ApplicationService } from '@adonisjs/core/types';
import { setBootedApp } from '../services/booted_app.js';
import { AuthzService } from '../src/authz_service.js';
import type { AuthzConfig } from '../src/define_config.js';
import { ScopeRegistry } from '../src/scope.js';

/**
 * Registers the {@link AuthzService} as a container singleton built from the
 * active store driver in `config/authz.ts`. The Bouncer abilities published into
 * `app/abilities/authz.ts` resolve this service to answer DB-backed checks.
 *
 * Resolve it anywhere via the service singleton:
 *
 * ```ts
 * import authz from '@adonis-agora/authz/services/main'
 * ```
 *
 * or directly from the container: `await app.container.make(AuthzService)`.
 */
export default class AuthzProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    // Hand the booted app to the service singleton so it never has to `import` an @adonisjs/core
    // copy that may not be the one bin/server booted (see services/booted_app.ts).
    setBootedApp(this.app);

    this.app.container.singleton(AuthzService, async () => {
      const config = this.app.config.get<AuthzConfig>('authz', {});
      const {
        default: defaultStore,
        stores: providers,
        superAdmin,
        resolveSubjectRef,
        tenant,
        resolveTenant,
        superAdminRoles,
        resolveRoles,
        resolveRoleMembers,
        resolveGlobalRoleMembers,
        roleGrants,
        scopes,
      } = config;

      if (!providers || Object.keys(providers).length === 0) {
        throw new Error('@adonis-agora/authz: config.stores is empty — define at least one store.');
      }

      const activeKey = defaultStore ?? Object.keys(providers)[0];
      if (!activeKey || !providers[activeKey]) {
        throw new Error(
          `@adonis-agora/authz: config.default is "${String(defaultStore)}", but config.stores.${String(
            defaultStore,
          )} is not defined`,
        );
      }

      const store = await providers[activeKey]({ app: this.app });

      // A pre-built registry is used as-is; a builder callback registers onto a fresh one.
      let registry: ScopeRegistry | undefined;
      if (scopes instanceof ScopeRegistry) {
        registry = scopes;
      } else if (typeof scopes === 'function') {
        registry = new ScopeRegistry();
        scopes(registry);
      }

      return new AuthzService({
        store,
        ...(superAdmin !== undefined ? { superAdmin } : {}),
        ...(resolveSubjectRef !== undefined ? { resolveSubjectRef } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
        ...(resolveTenant !== undefined ? { resolveTenant } : {}),
        ...(superAdminRoles !== undefined ? { superAdminRoles } : {}),
        ...(resolveRoles !== undefined ? { resolveRoles } : {}),
        ...(resolveRoleMembers !== undefined ? { resolveRoleMembers } : {}),
        ...(resolveGlobalRoleMembers !== undefined ? { resolveGlobalRoleMembers } : {}),
        ...(roleGrants !== undefined ? { roleGrants } : {}),
        ...(registry !== undefined ? { scopes: registry } : {}),
      });
    });
  }
}
