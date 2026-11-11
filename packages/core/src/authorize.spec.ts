import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeByRoles } from './authorize.js';
import { AuthzService } from './authz_service.js';
import { MemoryPermissionStore } from './stores/memory.js';

// O helper resolve o AuthzService via `app.container.make` (mesmo seam do
// middleware requireRole nos dashboards). Stubamos o container para não bootar
// um app Adonis no teste.
const makeSpy = vi.fn();
vi.mock('@adonisjs/core/services/app', () => ({
  default: { container: { make: (key: unknown) => makeSpy(key) } },
}));

class User {
  constructor(
    public id: string,
    public type = 'user',
  ) {}
}

function makeService() {
  const store = new MemoryPermissionStore();
  const service = new AuthzService({ store });
  return { store, service };
}

function makeCtx(auth: unknown) {
  return { auth } as unknown as Parameters<ReturnType<typeof authorizeByRoles>>[0];
}

const signedIn = { user: new User('u1') };
const adonisAuthLike = { user: new User('u2') };
const anonymousLike = { user: null };

/**
 * Um `ctx.auth` do `@adonisjs/auth` numa rota sem middleware de auth (como as dos consoles):
 * `user` vazio até `check()` rodar; `check()` autentica pela sessão, se houver.
 */
function lazyAuth(sessionUser: unknown, attempted = false) {
  const auth = {
    user: undefined as unknown,
    authenticationAttempted: attempted,
    checks: 0,
    async check() {
      auth.checks += 1;
      auth.authenticationAttempted = true;
      auth.user = sessionUser ?? undefined;
      return sessionUser !== null && sessionUser !== undefined;
    },
  };
  return auth;
}

describe('authorizeByRoles', () => {
  beforeEach(() => {
    makeSpy.mockReset();
  });

  it('permite quando o usuário tem uma das roles', async () => {
    const { store, service } = makeService();
    await store.assignRole({ type: 'user', id: 'u1' }, 'ADMIN');
    makeSpy.mockReturnValue(service);

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(signedIn))).resolves.toBe(true);
    expect(makeSpy).toHaveBeenCalledWith(AuthzService);
  });

  it('lê só ctx.auth.user: um getUser() sem .user conta como sem sessão', async () => {
    const { store } = makeService();
    await store.assignRole({ type: 'user', id: 'u1' }, 'ADMIN');
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    const getUserOnly = { getUser: () => Promise.resolve(new User('u1')) };
    await expect(authorize(makeCtx(getUserOnly))).resolves.toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('permite quando o usuário tem uma das roles (adonis auth .user)', async () => {
    const { store } = makeService();
    await store.assignRole({ type: 'user', id: 'u2' }, 'EDITOR');
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN', 'EDITOR'] });
    await expect(authorize(makeCtx(adonisAuthLike))).resolves.toBe(true);
  });

  it('nega com reason forbidden quando o usuário está logado sem nenhuma das roles', async () => {
    const { store } = makeService();
    await store.assignRole({ type: 'user', id: 'u1' }, 'ADVISEE');
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(signedIn))).resolves.toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });

  it('logado sem o papel: forbidden e NÃO redireciona pro login, mesmo com loginPath', async () => {
    const { store } = makeService();
    await store.assignRole({ type: 'user', id: 'u1' }, 'ADVISEE');
    makeSpy.mockReturnValue(new AuthzService({ store }));
    const redirect = vi.fn();
    const ctx = {
      auth: signedIn,
      request: { header: () => 'text/html', url: () => '/telescope' },
      response: { redirect },
    };

    const authorize = authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' });
    await expect(authorize(ctx)).resolves.toEqual({ allowed: false, reason: 'forbidden' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('nega usuário anônimo com reason unauthenticated', async () => {
    const { store } = makeService();
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(anonymousLike))).resolves.toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
    // Sem usuário o AuthzService nem é consultado.
    expect(makeSpy).not.toHaveBeenCalled();
  });

  it('nega com reason unauthenticated quando não há ctx.auth', async () => {
    const { store } = makeService();
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(undefined))).resolves.toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  describe('autenticação sob demanda (rota de console, sem middleware de auth)', () => {
    it('sessão válida: autentica com check() uma vez e confere o papel', async () => {
      const { store } = makeService();
      await store.assignRole({ type: 'user', id: 'u1' }, 'ADMIN');
      makeSpy.mockReturnValue(new AuthzService({ store }));
      const auth = lazyAuth(new User('u1'));

      await expect(authorizeByRoles({ roles: ['ADMIN'] })(makeCtx(auth))).resolves.toBe(true);
      expect(auth.checks).toBe(1);
    });

    it('sessão válida sem o papel: forbidden', async () => {
      const { store } = makeService();
      makeSpy.mockReturnValue(new AuthzService({ store }));
      const auth = lazyAuth(new User('u1'));

      await expect(authorizeByRoles({ roles: ['ADMIN'] })(makeCtx(auth))).resolves.toEqual({
        allowed: false,
        reason: 'forbidden',
      });
    });

    it('sem sessão: unauthenticated', async () => {
      const auth = lazyAuth(null);
      await expect(authorizeByRoles({ roles: ['ADMIN'] })(makeCtx(auth))).resolves.toEqual({
        allowed: false,
        reason: 'unauthenticated',
      });
      expect(auth.checks).toBe(1);
    });

    it('não chama check() de novo quando o guard já tentou (authenticationAttempted)', async () => {
      const auth = lazyAuth(new User('u1'), true);
      await expect(authorizeByRoles({ roles: ['ADMIN'] })(makeCtx(auth))).resolves.toEqual({
        allowed: false,
        reason: 'unauthenticated',
      });
      expect(auth.checks).toBe(0);
    });

    it('não chama check() quando ctx.auth.user já está preenchido', async () => {
      const { store } = makeService();
      await store.assignRole({ type: 'user', id: 'u1' }, 'ADMIN');
      makeSpy.mockReturnValue(new AuthzService({ store }));
      const auth = { ...lazyAuth(null), user: new User('u1') };

      await expect(authorizeByRoles({ roles: ['ADMIN'] })(makeCtx(auth))).resolves.toBe(true);
      expect(auth.checks).toBe(0);
    });

    it('um erro de verdade no check() sobe', async () => {
      const auth = {
        authenticationAttempted: false,
        check: () => Promise.reject(new Error('session store down')),
      };
      await expect(authorizeByRoles({ roles: ['ADMIN'] })(makeCtx(auth))).rejects.toThrow(
        'session store down',
      );
    });
  });
});
