/**
 * O mínimo do `ctx.auth` de um `@adonisjs/auth` que a authz lê, estruturalmente (sem depender do
 * pacote): `user`, `authenticationAttempted` e `check()`.
 */
export interface AuthLike {
  user?: unknown;
  authenticationAttempted?: boolean;
  check?: () => Promise<boolean>;
}

/**
 * O usuário autenticado do request, autenticando sob demanda.
 *
 * As rotas que os consoles das libs montam (durable, telescope, payments, media) não passam por um
 * middleware de auth do app, então `ctx.auth.user` chega vazio mesmo com sessão válida. Quando o
 * guard ainda não tentou (`authenticationAttempted` falso), chama `ctx.auth.check()` — o contrato
 * documentado do `@adonisjs/auth`: autentica se houver credencial e devolve `false` se não houver,
 * sem lançar. Um erro de verdade (store de sessão fora, por exemplo) sobe.
 *
 * Isto NÃO é o antigo `getUser()` do authkit-client: é a API do próprio `@adonisjs/auth`.
 */
export async function resolveAuthUser(auth: AuthLike | null | undefined): Promise<unknown> {
  if (!auth) return null;
  if (
    (auth.user === null || auth.user === undefined) &&
    !auth.authenticationAttempted &&
    typeof auth.check === 'function'
  ) {
    const ok = await auth.check();
    if (!ok) return null;
  }
  return auth.user ?? null;
}
