import type { AuthzService } from './authz_service.js';
import type { TenantScope, UserRef } from './user_ref.js';

/**
 * The instance methods the {@link hasPermissions} mixin adds to a Lucid model.
 * These are sugar that delegate to the {@link AuthzService}/{@link PermissionStore}.
 */
export interface HasPermissions {
  /** This model's polymorphic user reference (resolved via the service). */
  authzRef(): UserRef;
  assignRole(role: string, scope?: TenantScope): Promise<void>;
  removeRole(role: string, scope?: TenantScope): Promise<void>;
  givePermission(permission: string): Promise<void>;
  revokePermission(permission: string): Promise<void>;
  getRoles(scope?: TenantScope): Promise<string[]>;
  getPermissions(scope?: TenantScope): Promise<string[]>;
  /** Wildcard-aware permission check (e.g. `posts.*` ⊇ `posts.edit`). */
  can(permission: string, scope?: TenantScope): Promise<boolean>;
  hasRole(role: string, scope?: TenantScope): Promise<boolean>;
}

/**
 * A Lucid model mixin adding `assignRole` / `can` / ... sugar that delegates to
 * the store. The {@link AuthzService} is supplied lazily so this module does not
 * eagerly import the container.
 *
 * ```ts
 * import { compose } from '@adonisjs/core/helpers'
 * import { hasPermissions } from '@adonis-agora/authz/mixins'
 * import authz from '#services/authz' // your resolved AuthzService
 *
 * export default class User extends compose(BaseModel, hasPermissions(() => authz)) {}
 * ```
 */
export function hasPermissions(resolve: () => AuthzService | Promise<AuthzService>) {
  const authzService = (): Promise<AuthzService> => Promise.resolve(resolve());

  // TypeScript requires `any[]` for a class expression that extends a generic constructor.
  // The public return type below preserves the actual model instance type.
  // biome-ignore lint/suspicious/noExplicitAny: required by TypeScript's mixin class constraint
  return <Model extends new (...args: any[]) => object>(superclass: Model) => {
    class WithPermissions extends superclass implements HasPermissions {
      authzRef(): UserRef {
        // Resolved synchronously is not possible without the service; callers of
        // the async methods below never need this, but it is exposed for parity.
        throw new Error(
          '@adonis-agora/authz: authzRef() requires the service; use the async helpers instead.',
        );
      }

      async assignRole(role: string, scope?: TenantScope): Promise<void> {
        const service = await authzService();
        const ref = service.refOf(this);
        if (!ref)
          throw new Error(
            '@adonis-agora/authz: could not resolve a user reference for this model.',
          );
        await service.store.assignRole(ref, role, scope);
      }

      async removeRole(role: string, scope?: TenantScope): Promise<void> {
        const service = await authzService();
        const ref = service.refOf(this);
        if (!ref) return;
        await service.store.removeRole(ref, role, scope);
      }

      async givePermission(permission: string): Promise<void> {
        const service = await authzService();
        const ref = service.refOf(this);
        if (!ref)
          throw new Error(
            '@adonis-agora/authz: could not resolve a user reference for this model.',
          );
        await service.store.giveUserPermission(ref, permission);
      }

      async revokePermission(permission: string): Promise<void> {
        const service = await authzService();
        const ref = service.refOf(this);
        if (!ref) return;
        await service.store.revokeUserPermission(ref, permission);
      }

      async getRoles(scope?: TenantScope): Promise<string[]> {
        const service = await authzService();
        const ref = service.refOf(this);
        if (!ref) return [];
        return service.store.getRolesForUser(ref, service.currentScope(scope));
      }

      async getPermissions(scope?: TenantScope): Promise<string[]> {
        const service = await authzService();
        const ref = service.refOf(this);
        if (!ref) return [];
        return service.store.getPermissionsForUser(ref, service.currentScope(scope));
      }

      async can(permission: string, scope?: TenantScope): Promise<boolean> {
        const service = await authzService();
        return service.can(this, permission, scope ? { scope } : {});
      }

      async hasRole(role: string, scope?: TenantScope): Promise<boolean> {
        const service = await authzService();
        return service.hasRole(this, role, scope ? { scope } : {});
      }
    }

    return WithPermissions as unknown as {
      new (...args: ConstructorParameters<Model>): InstanceType<Model> & HasPermissions;
    } & Omit<Model, 'prototype'>;
  };
}
