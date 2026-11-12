import type { ApplicationService } from '@adonisjs/core/types';
import { AGORA_CONTEXT_TENANCY } from '../agora/tenancy.js';
import { AuthzService } from '../authz_service.js';
import type { AuthzConfig } from '../define_config.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/authz';

function configOf(app: ApplicationService): AuthzConfig {
  return app.config.get<AuthzConfig>('authz', {});
}

/** Whether context tenancy is on: the published slot when context loaded, else `config/context.ts`. */
function contextTenancyEnabled(app: ApplicationService): boolean {
  const slot = (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_TENANCY] as
    | { version?: number; tenancy?: () => { enabled?: boolean } }
    | undefined;
  if (slot?.version === 1 && typeof slot.tenancy === 'function') {
    try {
      return slot.tenancy()?.enabled === true;
    } catch {
      return false;
    }
  }
  return app.config.get<boolean>('context.tenancy.enabled', false) === true;
}

/** Whether authz's own `tenancy` option is on against context. */
function tenancyOn(app: ApplicationService, config: AuthzConfig): boolean {
  const option = config.tenancy;
  if (option === false) return false;
  const own = typeof option === 'object' && option !== null ? option.enabled : undefined;
  if (own === true || own === false) return own;
  return contextTenancyEnabled(app);
}

/** The doctor checks of `@adonis-agora/authz` (ids frozen for 1.x). */
export function authzDoctorChecks(): AgoraDoctorCheck[] {
  return [
    {
      id: 'authz.config',
      lib: 'authz',
      title: 'Store configured',
      run(app): AgoraDoctorResult {
        const config = configOf(app);
        const names = Object.keys(config.stores ?? {});
        if (names.length === 0) {
          return {
            status: 'error',
            message: 'config.stores is empty: the authz service cannot be built',
            fix: 'Add a store to config/authz.ts, e.g. `stores: { lucid: stores.lucid() }`',
            docs: `${DOCS}/config`,
          };
        }
        if (config.default !== undefined && !names.includes(config.default)) {
          return {
            status: 'error',
            message: `config.default is "${config.default}", which is not in config.stores`,
            fix: `Set default to one of: ${names.join(', ')}`,
            docs: `${DOCS}/config`,
          };
        }
        return { status: 'ok', message: `store: ${config.default ?? names[0]}` };
      },
    },
    {
      id: 'authz.super-admin',
      lib: 'authz',
      title: 'Super-admin rules',
      run(app): AgoraDoctorResult {
        const config = configOf(app);
        const roles = config.superAdminRoles ?? [];
        const parts = [
          ...(roles.length > 0 ? [`superAdminRoles: ${roles.join(', ')}`] : []),
          ...(config.superAdmin !== undefined ? ['a superAdmin hook'] : []),
        ];
        if (parts.length === 0)
          return { status: 'ok', message: 'no super-admin bypass configured' };
        return {
          status: 'ok',
          message: `${parts.join(' and ')} allow everything${app.inProduction ? ' in production' : ''}`,
        };
      },
    },
    {
      id: 'authz.tenancy',
      lib: 'authz',
      title: 'Organization as tenant',
      run(app): AgoraDoctorResult | AgoraDoctorResult[] {
        const config = configOf(app);
        const option = config.tenancy;
        const declared = typeof option === 'object' && option !== null ? option.roles : undefined;
        const roles =
          declared !== undefined && Object.keys(declared).length > 0 ? declared : undefined;
        const on = tenancyOn(app, config);
        if (!on) {
          if (roles !== undefined) {
            return {
              status: 'warn',
              message: 'tenancy.roles is set but tenancy is off, so org roles map to nothing',
              fix: 'Set `tenancy: { enabled: true }` in config/context.ts (or remove tenancy.roles)',
              docs: `${DOCS}/agora-integration#organization-as-tenant`,
            };
          }
          return { status: 'skip', message: 'tenancy is off' };
        }
        const results: AgoraDoctorResult[] = [];
        if (config.tenant !== undefined || config.resolveTenant !== undefined) {
          results.push({
            status: 'ok',
            message:
              'tenancy is on, and `tenant`/`resolveTenant` in config/authz.ts pick the tenant instead of the context',
          });
        } else {
          results.push({ status: 'ok', message: 'checks default to the active tenant' });
        }
        const grants = config.roleGrants ?? {};
        const ungranted = [
          ...new Set(
            Object.values(roles ?? {}).flatMap((value) =>
              typeof value === 'string' ? [value] : value,
            ),
          ),
        ].filter((role) => !Object.hasOwn(grants, role));
        if (ungranted.length > 0) {
          results.push({
            status: 'warn',
            message: `tenancy.roles maps to ${ungranted.join(', ')}, which roleGrants gives no permissions`,
            fix: `Add ${ungranted.map((r) => `${r}: [...]`).join(', ')} to roleGrants in config/authz.ts`,
            docs: `${DOCS}/agora-integration#org-roles-as-authz-roles`,
          });
        }
        return results;
      },
    },
    {
      id: 'authz.store-reachable',
      lib: 'authz',
      title: 'Store answers',
      cost: 'deep',
      async run(app): Promise<AgoraDoctorResult> {
        const authz = await app.container.make(AuthzService);
        const roles = await authz.store.listRoles();
        return { status: 'ok', message: `${roles.length} role(s) in the store` };
      },
    },
    {
      id: 'authz.catalog-sync',
      lib: 'authz',
      title: 'Catalog synced to the store',
      cost: 'deep',
      async run(app): Promise<AgoraDoctorResult> {
        const catalog = configOf(app).catalog;
        const declaredRoles = Object.entries(catalog?.roles ?? {});
        const declaredPermissions = new Set([
          ...(catalog?.permissions ?? []),
          ...declaredRoles.flatMap(([, permissions]) => permissions),
        ]);
        if (declaredRoles.length === 0 && declaredPermissions.size === 0) {
          return { status: 'skip', message: 'no catalog in config/authz.ts' };
        }
        const authz = await app.container.make(AuthzService);
        const [storedRoles, storedPermissions] = await Promise.all([
          authz.store.listRoles(),
          authz.store.listPermissions(),
        ]);
        const roleSet = new Set(storedRoles);
        const missingRoles = declaredRoles.filter(([role]) => !roleSet.has(role)).map(([r]) => r);
        const permissionSet = new Set(storedPermissions);
        const missingPermissions = [...declaredPermissions].filter((p) => !permissionSet.has(p));
        const missingGrants: string[] = [];
        for (const [role, permissions] of declaredRoles) {
          if (!roleSet.has(role)) continue;
          const granted = new Set(await authz.store.getRolePermissions(role));
          for (const permission of permissions) {
            if (!granted.has(permission)) missingGrants.push(`${role} → ${permission}`);
          }
        }
        const problems = [
          ...(missingRoles.length > 0 ? [`roles ${missingRoles.join(', ')}`] : []),
          ...(missingPermissions.length > 0 ? [`${missingPermissions.length} permission(s)`] : []),
          ...(missingGrants.length > 0 ? [`${missingGrants.length} role grant(s)`] : []),
        ];
        if (problems.length === 0) {
          return {
            status: 'ok',
            message: `${declaredRoles.length} catalog role(s) present in the store`,
          };
        }
        return {
          status: 'warn',
          message: `the catalog in config/authz.ts is not in the store: ${problems.join(', ')} missing`,
          fix: 'Run `node ace authz:sync`',
          docs: `${DOCS}/commands`,
        };
      },
    },
  ];
}
