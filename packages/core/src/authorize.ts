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

/**
 * Mínimo do ctx que o redirect de login lê. Tudo opcional: cada lib de dashboard
 * tipa o `authorize` do seu jeito (durable/payments: `HttpContext`; telescope:
 * `UiHttpContext` framework-light), então lemos estruturalmente e desistimos do
 * redirect quando a peça não existe, em vez de estourar.
 */
interface RedirectableCtx {
  request?: { header?: (name: string) => string | undefined; url?: () => string };
  response?: { redirect?: (url: string) => unknown; getHeader?: (name: string) => unknown };
}

export interface AuthorizeByRolesOptions {
  /** Papéis aceitos (any-of): passa se o usuário tiver PELO MENOS UM. */
  roles: string[];
  /** Escopo de tenant repassado a `effectiveRoles`. */
  scope?: TenantScope;
  /**
   * Rota de login do app. Quando presente, uma navegação de PÁGINA sem sessão é
   * redirecionada para lá em vez de receber a resposta de negação do dashboard.
   *
   * Sem isto, abrir um dashboard com a sessão expirada dá uma página "401 — é
   * preciso estar autenticado" SEM SAÍDA: o dashboard sabe dizer que falta login e
   * não sabe pedir login. O jeito de sair é ir até o app na mão, deixar a sessão
   * renovar, e voltar. Todos os dashboards @adonis-agora (telescope, durable,
   * media, payments) honram um `location` escrito pelo hook antes de escreverem a
   * própria negação, então o redirect daqui prevalece.
   *
   * Ex.: `loginPath: '/auth/login'`.
   */
  loginPath?: string;
  /**
   * Nome do parâmetro que carrega o destino de volta. Default `'redirect'` —
   * `/auth/login?redirect=%2Ftelescope`. Passe o nome que a SUA rota de login lê.
   */
  returnToParam?: string;
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
 * Sem usuário autenticado → `false` (nega; o guard do dashboard responde 401/403).
 * Com `loginPath`, uma navegação de página sem sessão é mandada para o login em vez
 * de morrer num 401 sem saída — ver {@link AuthorizeByRolesOptions.loginPath}.
 *
 * O parâmetro é `unknown` de propósito: cada lib de dashboard tipa o ctx do
 * `authorize` do seu jeito (durable: `HttpContext`; telescope: `UiHttpContext`
 * framework-light), e o helper só lê `ctx.auth` estruturalmente — então ele
 * aceita qualquer ctx e o cast é interno.
 */
export function authorizeByRoles(options: AuthorizeByRolesOptions) {
  const { roles, scope, loginPath, returnToParam = 'redirect' } = options;

  return async (ctx: unknown): Promise<boolean> => {
    const auth = (ctx as { auth?: AuthLike } | null | undefined)?.auth;
    const user = auth ? ((await auth.getUser?.()) ?? auth.user ?? null) : null;

    if (!user) {
      // SEM SESSÃO. É o único caso que vale redirecionar: quem já está logado e só
      // não tem o papel voltaria daqui com a mesma negativa, ou seja, um laço.
      if (loginPath !== undefined) {
        redirectToLogin(ctx as RedirectableCtx | null | undefined, loginPath, returnToParam);
      }
      return false;
    }

    const authz = await app.container.make(AuthzService);
    const effective = await authz.effectiveRoles(user, scope);
    return roles.some((role) => effective.includes(role));
  };
}

/**
 * Escreve o redirect para o login, quando faz sentido. Silencioso quando não faz —
 * o retorno do `authorize` continua sendo `false` de qualquer jeito, então falhar
 * aqui só significa "o dashboard responde a negação dele", nunca um erro na tela.
 *
 * Só redireciona NAVEGAÇÃO DE PÁGINA (`Accept: text/html`). Um 302 numa chamada de
 * API do próprio dashboard faria o `fetch` do SPA receber o HTML do login no lugar
 * do JSON que ele espera — trocaria um 401 honesto por um erro de parse.
 */
function redirectToLogin(
  ctx: RedirectableCtx | null | undefined,
  loginPath: string,
  returnToParam: string,
): void {
  const request = ctx?.request;
  const redirect = ctx?.response?.redirect;
  if (typeof redirect !== 'function') return;

  const accept = request?.header?.('accept') ?? '';
  if (!accept.includes('text/html')) return;

  // O destino é a URL da REQUEST — conhecida pelo servidor, nunca vinda do cliente,
  // então não há open redirect a introduzir aqui. Ainda assim a rota de login deve
  // validar o que recebe: ela é pública e alguém pode montar o link à mão.
  const current = typeof request?.url === 'function' ? request.url() : undefined;
  const target =
    current === undefined
      ? loginPath
      : `${loginPath}${loginPath.includes('?') ? '&' : '?'}${returnToParam}=${encodeURIComponent(current)}`;

  redirect.call(ctx?.response, target);
}
