import { AuthzService } from '../authz_service.js';
import type { AuthzConfig } from '../define_config.js';
import type { AuthzDevToolsDeps } from './tools.js';

/** The slice of the AdonisJS app {@link authzDevToolsDepsOf} reads. */
export interface AuthzDevToolsApp {
  container: { make(binding: typeof AuthzService): Promise<AuthzService> };
  config: { get<T>(key: string, defaultValue?: unknown): T };
}

/**
 * The dev tools' deps from the booted app: the {@link AuthzService} singleton plus `catalog`,
 * `roleGrants` and the `devTools` hooks of config/authz.ts, all read at call time. The provider
 * registers the MCP tools with it and the `authz:*` ace commands build their reads on it, so both
 * see the same thing.
 */
export function authzDevToolsDepsOf(app: AuthzDevToolsApp): AuthzDevToolsDeps {
  const config = () => app.config.get<AuthzConfig>('authz', {}) ?? {};
  return {
    service: () => app.container.make(AuthzService),
    catalog: () => config().catalog,
    roleGrants: () => config().roleGrants,
    options: () => {
      const current = config().devTools;
      return typeof current === 'object' && current !== null ? current : {};
    },
  };
}
