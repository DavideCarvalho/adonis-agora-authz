import { inject } from '@adonisjs/core';
import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { AuthzService } from './authz_service.js';
import { permissionMatches, permissionSatisfied } from './permission_matcher.js';
import type { TenantScope } from './subject_ref.js';

/**
 * Estrutura mínima do `ctx.auth` que o middleware lê — estrutural, para funcionar com o
 * `Authenticator` do `@adonis-agora/authkit-client` (`getUser()`) ou com um guard `@adonisjs/auth`
 * (`.user`), sem depender de nenhum dos dois.
 */
interface AuthLike {
  getUser?: () => Promise<unknown>;
  user?: unknown;
}

/**
 * A rota abre quando UMA permissão concedida casa com a entrada exigida.
 * O curinga pode estar dos dois lados, e os dois são legítimos:
 * - uma concessão `admin.*` (o grant) abre a rota que exige `admin.users`;
 * - a rota listada como `admin.*` ("qualquer admin.*") abre para quem só tem
 *   `admin.users` — é isto que deixa uma área admitir papéis criados em runtime.
 * `permissionSatisfied` cobre só o primeiro sentido (o curinga no GRANTED);
 * o segundo é o espelho, e é o que a rota traz quando quem escreve a rota não
 * conhece os nomes exatos.
 */
function opensBy(granted: readonly string[], required: string): boolean {
  return (
    permissionSatisfied(granted, required) || granted.some((g) => permissionMatches(required, g))
  );
}

export interface RequireRoleOptions {
  /**
   * Papéis aceitos (any-of): passa se o usuário tiver PELO MENOS UM.
   * Obrigatório junto com `permissions`: ao menos uma das duas listas.
   */
  roles?: string[];
  /**
   * Permissões aceitas (any-of, com curinga via `permissionSatisfied`): passa se as permissões
   * EFETIVAS do usuário concederem ao menos uma. Abre a rota por permissão — uma área
   * `"admin.*"` admite papéis criados em runtime sem nenhuma rota listá-los. Só é lida quando
   * os `roles` não bastam.
   */
  permissions?: string[];
  /** Escopo de tenant repassado a `effectiveRoles`/`effectivePermissions`. */
  scope?: TenantScope;
  /** Para onde redirecionar um request NÃO-autenticado. Sem isto → responde 401. */
  guestRedirect?: string;
  /** Para onde redirecionar quando falta papel/permissão. Sem isto → responde 403. */
  deniedRedirect?: string;
  /** Mensagem do 403 quando não há `deniedRedirect` nem `onDenied`. Default `'Forbidden'`. */
  deniedMessage?: string;
  /**
   * Negação decidida pelo HOST (redirect para a área do próprio usuário, flash, 403 customizado)
   * em vez do redirect fixo. Recebe o `ctx` e o que já foi resolvido — roles e permissões
   * efetivas (permissões só vêm resolvidas quando a rota as lista em `permissions`).
   * O retorno é entregue como resposta; devolver `undefined` deixa o fluxo seguir sem resposta —
   * quem decide negar DEVE responder (ou lançar).
   */
  onDenied?: (ctx: HttpContext, effective: { roles: string[]; permissions: string[] }) => unknown;
}

/**
 * Middleware de rota que abre o acesso por PAPEL e/ou PERMISSÃO via
 * {@link AuthzService.effectiveRoles}/{@link AuthzService.effectivePermissions} (global ∪ app ∪
 * store) — cobre num só lugar tanto papéis globais (claim do token) quanto papéis de app (DB),
 * e áreas que abrem por permissão (ex.: qualquer `admin.*`) sem editar rotas a cada papel novo.
 * Substitui os middlewares "exige role X" que cada app reescreve por papel. Registre como named
 * middleware e passe as listas por rota:
 *
 * ```ts
 * // start/kernel.ts
 * export const middleware = router.named({
 *   requireRole: () => import('@adonis-agora/authz/middleware'),
 * })
 * // rotas
 * router.get('/coordenador', ...).use(middleware.requireRole({ roles: ['COORDINATOR'] }))
 * router.get('/admin', ...).use(middleware.requireRole({ permissions: ['admin.*'] }))
 * router.get('/painel', ...).use(
 *   middleware.requireRole({
 *     roles: ['ADMIN'],
 *     deniedRedirect: '/unauthorized',
 *   }),
 * )
 * ```
 *
 * O usuário vem de `ctx.auth.getUser()` (authkit) ou `ctx.auth.user`; `effectiveRoles` popula os
 * papéis globais do contexto no caminho, então `roles: ['ADMIN']` casa pelo claim do token.
 *
 * O {@link AuthzService} entra por injeção de construtor (`@inject()`): o container do Adonis resolve o
 * middleware por request e injeta o serviço — sem service locator (`container.make`) no meio do fluxo.
 */
@inject()
export default class AuthzRoleMiddleware {
  constructor(private authz: AuthzService) {}

  async handle(ctx: HttpContext, next: NextFn, options: RequireRoleOptions) {
    const roles = options.roles ?? [];
    const permissions = options.permissions ?? [];
    if (roles.length === 0 && permissions.length === 0) {
      throw new Error(
        '@adonis-agora/authz: requireRole needs at least one entry in `roles` or `permissions`',
      );
    }

    const auth = (ctx as unknown as { auth?: AuthLike }).auth;
    const user = auth ? ((await auth.getUser?.()) ?? auth.user ?? null) : null;
    if (user === null || user === undefined) {
      return options.guestRedirect
        ? ctx.response.redirect(options.guestRedirect)
        : ctx.response.unauthorized({ message: 'Unauthenticated' });
    }

    const effectiveRoles = await this.authz.effectiveRoles(user, options.scope);
    const byRole = roles.some((role) => effectiveRoles.includes(role));

    // As permissões só são lidas quando os papéis não bastam — o middleware não paga
    // uma segunda consulta por request que já passou pelo `roles`.
    let effectivePermissions: string[] = [];
    let byPermission = false;
    if (!byRole && permissions.length > 0) {
      effectivePermissions = await this.authz.effectivePermissions(user, options.scope);
      byPermission = permissions.some((required) => opensBy(effectivePermissions, required));
    }

    if (!byRole && !byPermission) {
      if (options.onDenied) {
        return options.onDenied(ctx, { roles: effectiveRoles, permissions: effectivePermissions });
      }
      return options.deniedRedirect
        ? ctx.response.redirect(options.deniedRedirect)
        : ctx.response.forbidden({ message: options.deniedMessage ?? 'Forbidden' });
    }

    return next();
  }
}
