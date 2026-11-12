import type { AuthzTenancyOption } from './agora/tenancy.js';
import type { SuperAdminHook, TenantResolver } from './authz_service.js';
import type { DecisionProvider } from './decision_provider.js';
import type { AuthzDevToolsOptions } from './dev_tools/tools.js';
import type { ScopeRegistry } from './scope.js';
import { type StoreProvider, stores } from './stores/factory.js';
import type { ResolveSubjectRef, SubjectRef, SubjectRefInput, TenantScope } from './subject_ref.js';

export interface AuthzConfig {
  /** Key of the active store in {@link AuthzConfig.stores}. */
  default?: string;
  /** Named stores, built with the `stores` factory (drivers-in-core). */
  stores?: Record<string, StoreProvider>;
  /** Optional super-admin hook: `true` allows, `false` denies, nullish falls through. */
  superAdmin?: SuperAdminHook;
  /** Map a host user object to a polymorphic user reference. */
  resolveSubjectRef?: ResolveSubjectRef;
  /** Resolve the active tenant for the current request (multi-tenancy). */
  tenant?: TenantResolver;
  /**
   * Opt-in tenant auto-scope (feature B). Defaults an unscoped check's tenant
   * to a resolver's value. Pass `tenantFromContext` to default to the active
   * Agora context's `tenantId`, or any custom resolver. Default unset —
   * behavior unchanged.
   */
  resolveTenant?: () => string | undefined;
  /**
   * Opt-in global-role bridge (feature C). Global role names (read structurally
   * from the Agora context store) that short-circuit allow as super-admin.
   */
  superAdminRoles?: string[];
  /**
   * Resolve as roles do app para um usuário — a fonte que NÃO está no token nem no store authz
   * (tipicamente uma tabela do domínio, ex. `user_roles`). As roles retornadas entram na união do
   * `can()`/`hasRole()`/`scope()` e são mapeadas por {@link roleGrants}, exatamente como as roles
   * globais do contexto. Opcional: ausente → só token + store decidem.
   */
  resolveRoles?: (user: SubjectRef, scope?: TenantScope) => Promise<string[]> | string[];
  /**
   * Domain reverse seam — the reverse counterpart of {@link resolveRoles}. Given a role, return the
   * user ids/refs that hold it in the app's own role source (e.g. `user_roles`). Feeds the union in
   * {@link AuthzService.subjectsWithRole}. Optional: absent → only the store and the global seam contribute.
   */
  resolveRoleMembers?: (
    role: string,
    scope?: TenantScope,
  ) => Promise<Array<string | SubjectRefInput>> | Array<string | SubjectRefInput>;
  /**
   * Global/IdP reverse seam — the reverse counterpart of the global (token) role claim. Given a role,
   * return the user ids/refs that hold it as a global/IdP role. Feeds the union in
   * {@link AuthzService.subjectsWithRole}. Optional: absent → the global side contributes nothing.
   */
  resolveGlobalRoleMembers?: (
    role: string,
    scope?: TenantScope,
  ) => Promise<Array<string | SubjectRefInput>> | Array<string | SubjectRefInput>;
  /**
   * Mapa role → permissões/wildcards, aplicado às roles EFETIVAS (contexto + resolver) sem seed no
   * store. (Antes: `globalRoleGrants`; renomeado porque não é só das roles globais.)
   */
  roleGrants?: Record<string, string[]>;
  /**
   * Declared roles → permissions catalog, seeded by `node ace authz:sync`.
   * Permissions listed are created and attached to each role (idempotent).
   */
  catalog?: AuthzCatalog;
  /**
   * Query-scope registry (feature E). A pre-built {@link ScopeRegistry}, or a builder
   * callback that registers resource scope filters on a fresh registry. Powers
   * {@link AuthzService.scope} and the Lucid `accessibleBy` helper. Unset → an empty
   * registry (every resource is deny-all / fail-closed until registered).
   */
  scopes?: ScopeRegistry | ((registry: ScopeRegistry) => void);
  /**
   * External policy decision point (Cerbos, OPA, …) — see {@link DecisionProvider}. Runs right
   * after the super-admin check: it can allow, deny or abstain (`undefined`) on `authz.can` /
   * the Bouncer `can` ability / `authz.canMany`, and plan query scopes for `authz.scope` /
   * `accessibleBy`. A Cerbos adapter ships at `@adonis-agora/authz/cerbos`.
   */
  decisionProvider?: DecisionProvider;
  /**
   * Organization-as-tenant (`@adonis-agora/context` tenancy). Default `'inherit'`: on when
   * `tenancy.enabled` is true in `config/context.ts`. When on, a check with no explicit `scope`
   * (and no `tenant`/`resolveTenant` above) runs in the active tenant's scope, and `roles` maps
   * the caller's role inside that tenant (authkit `orgRole`) to authz roles there:
   *
   * ```ts
   * tenancy: { roles: { owner: 'org_admin', member: 'org_member' } }
   * ```
   *
   * `false` keeps authz global even when context enables tenancy.
   */
  tenancy?: AuthzTenancyOption;
  /**
   * Developer tools on `@adonis-agora/agent`'s dev MCP endpoint (`/mcp/agora`), gated by its
   * `devTools.authorize`. Default `true`; `false` leaves them out. An object turns them on and
   * passes `loadSubject` / `loadResource`, so the decision provider (and the `superAdmin` hook, for
   * the resource) see your models instead of `{ type, id }` refs.
   */
  devTools?: boolean | AuthzDevToolsOptions;
}

/** A declarative roles → permissions map for `authz:sync`. */
export interface AuthzCatalog {
  /** Standalone permissions to create (in addition to those under roles). */
  permissions?: string[];
  /** role name → permission names granted to that role. */
  roles?: Record<string, string[]>;
}

/** Identity helper giving `config/authz.ts` full type-checking. */
export function defineConfig(config: AuthzConfig): AuthzConfig {
  return config;
}

export type { PermissionStore, StoreOptions, StoreQueryClient } from './store.js';
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
export type {
  AuthzSubjectIdType,
  AuthzTableNames,
  LucidDatabase,
  LucidQueryClient,
} from './stores/lucid-schema.js';
export { stores };
