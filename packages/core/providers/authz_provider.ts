import type { ApplicationService } from '@adonisjs/core/types';
import { setBootedApp } from '../services/booted_app.js';
import { AuthzService } from '../src/authz_service.js';
import type { AuthzConfig } from '../src/define_config.js';
import { authzDevToolsDepsOf } from '../src/dev_tools/deps.js';
import { registerAuthzDevTools } from '../src/dev_tools/tools.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { authzDoctorChecks } from '../src/doctor/checks.js';
import { ScopeRegistry } from '../src/scope.js';
import { assertStoreSchema, storeSchemaOf } from '../src/stores/factory.js';

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
        decisionProvider,
        tenancy,
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
        ...(decisionProvider !== undefined ? { decisionProvider } : {}),
        ...(tenancy !== undefined ? { tenancy } : {}),
      });
    });
  }

  /**
   * Registers the authz `agora:doctor` checks, and the authz developer tools on the agent's dev MCP endpoint (`/mcp/agora`) when
   * `@adonis-agora/agent`'s MCP provider is installed. `devTools: false` in config/authz.ts leaves
   * them out.
   */
  async boot() {
    // A `schema` the active store's database cannot honour (SQLite) fails the boot, before any
    // request reaches the store.
    const { default: active, stores: configured } = this.app.config.get<AuthzConfig>('authz', {});
    const provider = configured?.[active ?? Object.keys(configured ?? {})[0] ?? ''];
    if (provider) await assertStoreSchema(provider, { app: this.app });
    await registerDoctorChecks(
      this.app.container as never,
      authzDoctorChecks({ schema: storeSchemaOf(provider) !== undefined }),
    );
    const config = () => this.app.config.get<AuthzConfig>('authz', {});
    const devTools = config().devTools;
    if (devTools === false) return;
    const outcome = await registerAuthzDevTools(
      this.app.container as never,
      authzDevToolsDepsOf(this.app as never),
    );
    if (outcome === 'unsupported' || outcome === 'failed') {
      const logger = (await this.app.container.make('logger').catch(() => undefined)) as
        | { debug(msg: string): void }
        | undefined;
      logger?.debug(
        outcome === 'unsupported'
          ? '[@adonis-agora/authz] dev tools not registered: the installed @adonis-agora/agent cannot gate libs without a console (needs devTools.authorize support)'
          : '[@adonis-agora/authz] dev tools could not be registered',
      );
    }
  }
}
