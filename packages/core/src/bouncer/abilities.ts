import { AuthorizationResponse, Bouncer } from '@adonisjs/bouncer';
import type { AuthzService } from '../authz_service.js';

/** The two static, DB-backed abilities this library registers with Bouncer. */
export interface AuthzAbilities {
  /** `bouncer.allows('can', 'posts.edit', post?)` — wildcard permission check. */
  can: ReturnType<typeof Bouncer.ability>;
  /** `bouncer.allows('hasRole', 'admin')` — exact role check. */
  hasRole: ReturnType<typeof Bouncer.ability>;
}

/**
 * Build the static Bouncer abilities backed by an {@link AuthzService}.
 *
 * Bouncer has no runtime API to register one ability per DB row, so we register
 * a SMALL fixed set of abilities whose body consults the DB-backed store:
 *
 * - `can(user, permission, resource?)` — true when the user's grants (with
 *   wildcards, e.g. `posts.*` ⊇ `posts.edit`) satisfy `permission`. The optional
 *   `resource` is accepted for ergonomic call sites but RBAC grants are
 *   model-less, so it is not consulted by default.
 * - `hasRole(user, role)` — true when the user holds the named role.
 *
 * Both deny anonymous users (no `allowGuest`).
 */
export function defineAuthzAbilities(service: AuthzService): AuthzAbilities {
  const can = Bouncer.ability(async (user: unknown, permission: string, _resource?: unknown) => {
    const allowed = await service.can(user, permission);
    return allowed
      ? AuthorizationResponse.allow()
      : AuthorizationResponse.deny(`Missing permission: ${permission}`, 403);
  });

  const hasRole = Bouncer.ability(async (user: unknown, role: string) => {
    const allowed = await service.hasRole(user, role);
    return allowed
      ? AuthorizationResponse.allow()
      : AuthorizationResponse.deny(`Missing role: ${role}`, 403);
  });

  return { can, hasRole };
}

/**
 * Convenience for apps that resolve the {@link AuthzService} from the container
 * at module-eval time. Prefer {@link defineAuthzAbilities} when you already hold
 * a service instance (e.g. in tests).
 */
export async function authzAbilities(
  resolve: () => Promise<AuthzService> | AuthzService,
): Promise<AuthzAbilities> {
  const service = await resolve();
  return defineAuthzAbilities(service);
}
