import app from '@adonisjs/core/services/app';
import { AuthzService } from './authz_service.js';
import type { TenantScope } from './user_ref.js';

/**
 * Mínimo do `ctx.auth` que o helper lê — estrutural, para funcionar com o
 * `Authenticator` do `@adonis-agora/authkit-client` (`getUser()`) ou com um
 * guard `@adonisjs/auth` (`.user`), sem depender de nenhum dos dois.
 */
interface AuthLike {
  getUser?: () => Promise<unknown>;
  user?: unknown;
}

export interface AuthorizeByRolesOptions {
  /** Papéis aceitos (any-of): passa se o usuário tiver PELO MENOS UM. */
  roles: string[];
  /** Escopo de tenant repassado a `effectiveRoles`. */
  scope?: TenantScope;
}

/**
 * Factory de hooks de autorização para dashboards das libs @adonis-agora
 * (telescope, durable, media, agent). Mesma semântica do middleware
 * `requireRole`, mas no formato `(ctx) => boolean` que o `authorize` dos
 * dashboards espera:
 *
 * ```ts
 * // config/telescope_ui.ts
 * import { defineConfig } from '@adonis-agora/telescope/ui'
 * import { authorizeByRoles } from '@adonis-agora/authz'
 *
 * export default defineConfig({
 *   authorize: authorizeByRoles({ roles: ['ADMIN'] }),
 * })
 * ```
 *
 * O usuário vem de `ctx.auth.getUser()` (authkit) ou `ctx.auth.user`;
 * `effectiveRoles` popula os papéis globais do contexto no caminho, então
 * `roles: ['ADMIN']` casa pelo claim do token ou pela role de app (DB).
 *
 * Sem usuário autenticado → `false` (nega; o guard do dashboard responde
 * 401/403 — ou redireciona, se o hook de login estiver configurado).
 *
 * O parâmetro é `unknown` de propósito: cada lib de dashboard tipa o ctx do
 * `authorize` do seu jeito (durable: `HttpContext`; telescope: `UiHttpContext`
 * framework-light), e o helper só lê `ctx.auth` estruturalmente — então ele
 * aceita qualquer ctx e o cast é interno.
 */
export function authorizeByRoles(options: AuthorizeByRolesOptions) {
  const { roles, scope } = options;

  return async (ctx: unknown): Promise<boolean> => {
    const auth = (ctx as { auth?: AuthLike } | null | undefined)?.auth;
    const user = auth ? ((await auth.getUser?.()) ?? auth.user ?? null) : null;
    if (!user) return false;

    const authz = await app.container.make(AuthzService);
    const effective = await authz.effectiveRoles(user, scope);
    return roles.some((role) => effective.includes(role));
  };
}
