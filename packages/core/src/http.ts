/**
 * Feature D (backend) — the `POST /authz/can` endpoint helper.
 *
 * Opt-in: the host calls {@link registerCanEndpoint} to register a route that
 * answers a permission check for the active user using an {@link AuthzService}.
 *
 * CONTRACT (the frontend depends on this exactly):
 *   request  JSON: { "permission": string, "resource"?: string }
 *   response JSON: { "allowed": boolean }
 *
 * `@adonisjs/core` (router) is an optional structural peer — we type the router
 * loosely so this module imports with no hard dependency.
 */

import type { AuthzService } from './authz_service.js';

/** Minimal HTTP context shape we read (structural; not imported from core). */
interface CanHttpContext {
  request: {
    /** Parsed request body. */
    body?: () => Record<string, unknown>;
    input?: (key: string) => unknown;
  };
  /** The authenticated user, when an auth guard populated it. */
  auth?: { user?: unknown };
  response?: { json?: (body: unknown) => unknown };
}

/** Minimal router shape: just `.post(path, handler)`. */
interface CanRouter {
  post: (path: string, handler: (ctx: CanHttpContext) => unknown) => unknown;
}

export interface RegisterCanEndpointOptions {
  /** The authz engine to consult — the `services/main` singleton or an `AuthzService`. */
  service: Pick<AuthzService, 'can'>;
  /** Route path (default `/authz/can`). */
  path?: string;
  /**
   * Resolve the active user from the HTTP context. Defaults to `ctx.auth?.user`.
   * Override to read the user from the Agora context or a custom guard.
   */
  resolveUser?: (ctx: CanHttpContext) => unknown;
}

/** The request body shape for the can endpoint. */
export interface CanRequest {
  permission: string;
  resource?: string;
}

/** The response body shape for the can endpoint. */
export interface CanResponse {
  allowed: boolean;
}

function readBody(ctx: CanHttpContext): Record<string, unknown> {
  if (typeof ctx.request.body === 'function') {
    const body = ctx.request.body();
    if (body && typeof body === 'object') return body;
  }
  if (typeof ctx.request.input === 'function') {
    return {
      permission: ctx.request.input('permission'),
      resource: ctx.request.input('resource'),
    };
  }
  return {};
}

/**
 * Register `POST {path}` (default `/authz/can`). The handler reads
 * `{ permission, resource? }`, runs the active user through the
 * {@link AuthzService}, and returns `{ allowed }`. An unmappable/anonymous user
 * or a missing `permission` yields `{ allowed: false }`.
 */
export function registerCanEndpoint(router: CanRouter, opts: RegisterCanEndpointOptions): void {
  const path = opts.path ?? '/authz/can';
  const resolveUser = opts.resolveUser ?? ((ctx: CanHttpContext) => ctx.auth?.user);

  router.post(path, async (ctx: CanHttpContext): Promise<CanResponse> => {
    const body = readBody(ctx);
    const permission = typeof body.permission === 'string' ? body.permission : undefined;
    if (!permission) return { allowed: false };

    const user = resolveUser(ctx);
    const allowed = await opts.service.can(user, permission);
    return { allowed };
  });
}
