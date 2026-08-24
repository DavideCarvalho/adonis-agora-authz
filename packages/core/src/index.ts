export const VERSION = '0.11.0';

// Wildcard matcher (the core of the port).
export { permissionMatches, permissionSatisfied } from './permission_matcher.js';

// User references & tenancy.
export {
  defaultResolveUserRef,
  GLOBAL_TENANT,
  identityUserRef,
  normalizeTenant,
  normalizeUserRef,
} from './user_ref.js';
export type {
  IdentityLike,
  ResolveUserRef,
  TenantScope,
  UserAuthz,
  UserRef,
  UserRefInput,
} from './user_ref.js';

// Store contract & implementations.
export type { PermissionStore } from './store.js';
export { MemoryPermissionStore } from './stores/memory.js';
export { LucidPermissionStore } from './stores/lucid.js';
// Standalone Lucid schema helpers — for apps that set `autoCreateSchema: false` and
// create the RBAC tables from a Lucid migration (mirrors `@adonis-agora/durable`).
export {
  AUTHZ_TABLES,
  createAuthzTables,
  dropAuthzTables,
} from './stores/lucid-schema.js';
export type {
  AuthzTableNames,
  LucidDatabase,
  LucidPermissionStoreOptions,
  LucidQueryBindings,
  LucidQueryClient,
} from './stores/lucid.js';

// Per-request cache.
export { PermissionCache } from './permission_cache.js';

// The engine Bouncer abilities consult.
export { AuthzService } from './authz_service.js';
export type {
  AuthzServiceOptions,
  SuperAdminHook,
  TenantResolver,
} from './authz_service.js';

// Query-scope DSL (the `accessibleBy` constraint model).
export {
  and,
  assertSafeIdentifier,
  eq,
  normalizeScope,
  or,
  SAFE_IDENTIFIER,
  ScopeRegistry,
  scopeAll,
  scopeNone,
  where,
  whereIn,
} from './scope.js';
export type {
  ResourceKey,
  ScopeAll,
  ScopeCondition,
  ScopeConstraint,
  ScopeFilter,
  ScopeFilterContext,
  ScopeGroup,
  ScopeNode,
  ScopeNone,
  ScopeOperator,
  ScopeResult,
} from './scope.js';

// Structural Agora context bridge (features B & C).
export {
  AGORA_CONTEXT_ACCESSOR,
  globalRolesFromContext,
  readContextAccessor,
  readContextValue,
  tenantFromContext,
} from './agora/context.js';
export type { AgoraContextAccessor } from './agora/context.js';

// Bouncer integration helpers.
export { authzAbilities, defineAuthzAbilities } from './bouncer/abilities.js';
export type { AuthzAbilities } from './bouncer/abilities.js';

// Route middleware (default export; registrar como named middleware `@adonis-agora/authz/middleware`).
export { default as AuthzRoleMiddleware } from './middleware.js';
export type { RequireRoleOptions } from './middleware.js';

// Dashboard authorization hook factory (shared by telescope/durable/media/agent dashboards).
export { authorizeByRoles } from './authorize.js';
export type { AuthorizeByRolesOptions } from './authorize.js';

// Drivers-in-core config idiom.
export { defineConfig, stores } from './define_config.js';
export type { AuthzConfig } from './define_config.js';
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
