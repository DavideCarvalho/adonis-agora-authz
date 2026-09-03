import type { Bouncer } from '@adonisjs/bouncer';
import type { AuthzService } from '../authz_service.js';

/**
 * `@adonisjs/bouncer` is an OPTIONAL peer, so this module must stay importable
 * when it is not installed. That matters for `node ace add` / `node ace configure`:
 * Adonis imports the package MAIN entry to read the `configure` hook, and the main
 * entry re-exports this module — a static bouncer import here used to crash that
 * flow with a misleading `Cannot find module "@adonis-agora/authz"`.
 *
 * Bouncer is therefore pre-loaded with a top-level await that tolerates its absence
 * (importers transparently wait for module evaluation to settle).
 * `defineAuthzAbilities` stays synchronous and throws an actionable error only when
 * it is actually called without bouncer installed.
 */
type BouncerApi = typeof import('@adonisjs/bouncer');

let bouncerApi: BouncerApi | null | undefined;

/**
 * Duck-typed on purpose: `instanceof Error` is false for errors crossing a realm
 * boundary (bundlers, loaders, worker threads, test runners), and those are exactly
 * the environments where an optional peer goes missing in surprising ways.
 */
function isMissingBouncerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 'ERR_MODULE_NOT_FOUND' &&
    typeof message === 'string' &&
    message.includes('@adonisjs/bouncer')
  );
}

async function preloadBouncer(): Promise<void> {
  if (bouncerApi !== undefined) return;
  try {
    bouncerApi = await import('@adonisjs/bouncer');
  } catch (error) {
    if (isMissingBouncerError(error)) {
      bouncerApi = null;
    } else {
      throw error;
    }
  }
}

await preloadBouncer();

function requireBouncer(): BouncerApi {
  const api = bouncerApi as unknown as
    | { Bouncer?: { ability?: unknown }; AuthorizationResponse?: { allow?: unknown } }
    | null
    | undefined;
  if (
    !api ||
    typeof api.Bouncer?.ability !== 'function' ||
    typeof api.AuthorizationResponse?.allow !== 'function'
  ) {
    throw new Error(
      '[@adonis-agora/authz] `defineAuthzAbilities()` needs the optional peer `@adonisjs/bouncer`, which is not installed. Run `node ace add @adonisjs/bouncer` and try again.',
    );
  }
  return bouncerApi as BouncerApi;
}

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
  const { AuthorizationResponse, Bouncer } = requireBouncer();
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
