import { describe, expect, it } from 'vitest';
import { authorizeByRoles } from '../src/authorize.js';

/**
 * `loginPath` existe porque um dashboard sem sessão dava uma página "401 — é preciso
 * estar autenticado" SEM SAÍDA: ele sabia dizer que faltava login e não sabia pedir
 * login. O jeito de sair era ir até o app na mão, deixar a sessão renovar, e voltar.
 *
 * Todos os testes abaixo exercitam o caminho SEM USUÁRIO, que curto-circuita antes do
 * `AuthzService` — por isso nenhum precisa do container.
 */

/** ctx mínimo que registra o redirect escrito, com os headers e a url pedidos. */
function fakeCtx(options: { accept?: string; url?: string; withRedirect?: boolean } = {}) {
  const calls: { redirect?: string } = {};
  const ctx = {
    auth: { getUser: async () => null },
    request: {
      header: (name: string) =>
        name.toLowerCase() === 'accept' ? (options.accept ?? 'text/html') : undefined,
      ...(options.url !== undefined ? { url: () => options.url } : {}),
    },
    response: {
      ...(options.withRedirect === false
        ? {}
        : {
            redirect: (url: string) => {
              calls.redirect = url;
            },
          }),
    },
  };
  return { ctx, calls };
}

describe('authorizeByRoles — redirect de login', () => {
  it('sem sessão numa navegação de página, manda pro login carregando a volta', async () => {
    const { ctx, calls } = fakeCtx({ url: '/telescope' });
    const allowed = await authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' })(ctx);

    expect(allowed).toBe(false);
    expect(calls.redirect).toBe('/auth/login?redirect=%2Ftelescope');
  });

  it('escapa a url de volta (query e fragmento incluídos)', async () => {
    const { ctx, calls } = fakeCtx({ url: '/telescope?window=1h' });
    await authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' })(ctx);

    expect(calls.redirect).toBe('/auth/login?redirect=%2Ftelescope%3Fwindow%3D1h');
  });

  it('respeita um nome de parâmetro próprio', async () => {
    const { ctx, calls } = fakeCtx({ url: '/durable' });
    await authorizeByRoles({
      roles: ['ADMIN'],
      loginPath: '/entrar',
      returnToParam: 'returnTo',
    })(ctx);

    expect(calls.redirect).toBe('/entrar?returnTo=%2Fdurable');
  });

  it('usa `&` quando o loginPath já tem query', async () => {
    const { ctx, calls } = fakeCtx({ url: '/media' });
    await authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login?audience=admin' })(ctx);

    expect(calls.redirect).toBe('/auth/login?audience=admin&redirect=%2Fmedia');
  });

  it('NÃO redireciona chamada de API — o SPA espera JSON, não o HTML do login', async () => {
    const { ctx, calls } = fakeCtx({ accept: 'application/json', url: '/telescope/api/entries' });
    const allowed = await authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' })(ctx);

    expect(allowed).toBe(false);
    expect(calls.redirect).toBeUndefined();
  });

  it('sem loginPath, comportamento inalterado: nega sem redirecionar', async () => {
    const { ctx, calls } = fakeCtx({ url: '/telescope' });
    const allowed = await authorizeByRoles({ roles: ['ADMIN'] })(ctx);

    expect(allowed).toBe(false);
    expect(calls.redirect).toBeUndefined();
  });

  it('sem url no ctx, manda pro login sem a volta em vez de desistir', async () => {
    const { ctx, calls } = fakeCtx({});
    await authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' })(ctx);

    expect(calls.redirect).toBe('/auth/login');
  });

  it('sem `response.redirect` no ctx, apenas nega — nunca estoura', async () => {
    const { ctx } = fakeCtx({ url: '/telescope', withRedirect: false });
    await expect(
      authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' })(ctx),
    ).resolves.toBe(false);
  });

  it('ctx nulo ou sem auth continua negando sem estourar', async () => {
    const authorize = authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' });
    await expect(authorize(null)).resolves.toBe(false);
    await expect(authorize({})).resolves.toBe(false);
  });
});
