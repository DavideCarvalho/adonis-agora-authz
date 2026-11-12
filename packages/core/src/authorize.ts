import app from '@adonisjs/core/services/app';
import { type AuthLike, resolveAuthUser } from './auth_user.js';
import { AuthzService } from './authz_service.js';
import type { TenantScope } from './subject_ref.js';

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
   * Roles that see EVERY tenant in a console when tenancy is on (`@adonis-agora/context`): a viewer
   * holding one of them as a global role (token, app or store assignment in the global scope), or a
   * `superAdminRoles` role, is allowed with `tenants: '*'`. Everyone else allowed by `roles` sees
   * their own active tenant. Roles held only inside a tenant never count here.
   *
   * Ex.: `authorizeByRoles({ roles: ['ADMIN', 'org_admin'], allTenants: ['ADMIN'] })`.
   */
  allTenants?: string[];
  /**
   * Rota de login do app. Quando presente, uma navegação de PÁGINA sem sessão é
   * redirecionada para lá em vez de receber a resposta de negação do dashboard.
   *
   * Sem isto, abrir um dashboard com a sessão expirada dá uma página "401 — é
   * preciso estar autenticado" SEM SAÍDA: o dashboard sabe dizer que falta login e
   * não sabe pedir login. O jeito de sair é ir até o app na mão, deixar a sessão
   * renovar, e voltar. Todos os dashboards @adonis-agora (telescope, durable,
   * media, payments, agent) honram um `location` escrito pelo hook antes de escreverem a
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
 * Decisão rica de um gate de dashboard. Contrato COMPARTILHADO pelas libs de
 * dashboard @adonis-agora (telescope, durable, media, payments, agent) — cada lib
 * tem a sua cópia idêntica deste tipo; mantenha-as iguais.
 *
 * - `reason: 'unauthenticated'` → o dashboard responde `401`.
 * - `reason: 'forbidden'` (ou ausente) → `403`.
 * - Um redirect que o hook escreveu na response prevalece sobre os dois.
 *
 * ATENÇÃO: `{ allowed: false }` é um objeto, logo TRUTHY. Um consumidor que trata o
 * resultado como booleano (`if (!(await authorize(ctx)))`) DEIXA PASSAR quem
 * deveria ser negado. Leia sempre `result === true || result.allowed`.
 */
export interface AuthorizeDecision {
  allowed: boolean;
  reason?: 'unauthenticated' | 'forbidden';
  /**
   * Tenants an allowed viewer may see in a console with tenancy on: `'*'` = every tenant (and the
   * rows with none). Absent = the viewer's own active tenant. Ignored when tenancy is off.
   */
  tenants?: '*' | string[];
}

/**
 * O que um hook `authorize` de dashboard pode devolver: `true`/`false` (o
 * contrato antigo; `false` vira `403`) ou uma {@link AuthorizeDecision}.
 */
export type AuthorizeResult = boolean | AuthorizeDecision;

/**
 * Factory de hooks de autorização para dashboards das libs @adonis-agora
 * (telescope, durable, media, payments, agent). Mesma semântica do middleware
 * `requireRole`, no formato `(ctx) => Promise<AuthorizeResult>` que o
 * `authorize` dos dashboards espera:
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
 * O usuário vem de `ctx.auth.user` (autenticado sob demanda com `ctx.auth.check()` quando
 * nenhum middleware de auth rodou antes — as rotas dos consoles não passam por um);
 * `effectiveRoles` popula os papéis globais do contexto no caminho, então
 * `roles: ['ADMIN']` casa pelo claim do token ou pela role de app (DB).
 *
 * Retorno:
 * - tem um dos papéis → `true`;
 * - sem usuário autenticado → `{ allowed: false, reason: 'unauthenticated' }`
 *   (o dashboard responde `401`). Com `loginPath`, uma navegação de página sem
 *   sessão é mandada para o login em vez de morrer num 401 sem saída — ver
 *   {@link AuthorizeByRolesOptions.loginPath};
 * - autenticado sem nenhum dos papéis → `{ allowed: false, reason: 'forbidden' }`
 *   (`403`).
 *
 * REQUISITO DE VERSÃO: a negação é um OBJETO (truthy). Só use com versões das libs
 * de dashboard que aceitam `AuthorizeDecision` — numa versão antiga que faz
 * `if (!(await authorize(ctx)))`, a negação passaria. As versões antigas tipam o
 * hook como `(ctx) => boolean | Promise<boolean>`, então a combinação errada falha
 * no typecheck do app.
 *
 * O parâmetro é `unknown` de propósito: cada lib de dashboard tipa o ctx do
 * `authorize` do seu jeito (durable: `HttpContext`; telescope: `UiHttpContext`
 * framework-light), e o helper só lê `ctx.auth` estruturalmente — então ele
 * aceita qualquer ctx e o cast é interno.
 */
export function authorizeByRoles(
  options: AuthorizeByRolesOptions,
): (ctx: unknown) => Promise<AuthorizeResult> {
  const { roles, scope, allTenants, loginPath, returnToParam = 'redirect' } = options;

  return async (ctx: unknown): Promise<AuthorizeResult> => {
    const auth = (ctx as { auth?: AuthLike } | null | undefined)?.auth;
    const user = await resolveAuthUser(auth);

    if (!user) {
      // SEM SESSÃO. É o único caso que vale redirecionar: quem já está logado e só
      // não tem o papel voltaria daqui com a mesma negativa, ou seja, um laço.
      if (loginPath !== undefined) {
        redirectToLogin(ctx as RedirectableCtx | null | undefined, loginPath, returnToParam);
      }
      return { allowed: false, reason: 'unauthenticated' };
    }

    const authz = await app.container.make(AuthzService);
    if (allTenants !== undefined && (await seesAllTenants(authz, user, allTenants))) {
      return { allowed: true, tenants: '*' };
    }
    const effective = await authz.effectiveRoles(user, scope);
    return roles.some((role) => effective.includes(role))
      ? true
      : { allowed: false, reason: 'forbidden' };
  };
}

/**
 * Whether `user` sees every tenant: one of `allTenants` among its roles in the GLOBAL scope (a role
 * held only inside one tenant must never widen the console to all of them), or a `superAdminRoles`
 * role from the context.
 */
async function seesAllTenants(
  authz: AuthzService,
  user: unknown,
  allTenants: string[],
): Promise<boolean> {
  if (authz.isSuperAdminByRole(user)) return true;
  if (allTenants.length === 0) return false;
  const global = await authz.effectiveRoles(user, { tenantId: '' });
  return allTenants.some((role) => global.includes(role));
}

/**
 * Escreve o redirect para o login, quando faz sentido. Silencioso quando não faz —
 * o retorno do `authorize` continua sendo a negação `unauthenticated` de qualquer jeito, então falhar
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
