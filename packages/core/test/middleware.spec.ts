import { describe, expect, it } from 'vitest';
import type { AuthzService } from '../src/authz_service.js';
import AuthzRoleMiddleware from '../src/middleware.js';

/** AuthzService mínimo: só `effectiveRoles`, devolvendo os papéis fixados (injetado no construtor). */
function fakeAuthz(roles: string[]): AuthzService {
  return { effectiveRoles: async () => roles } as unknown as AuthzService;
}

/** AuthzService completo: conta as leituras de roles e permissões. */
function fakeAuthzFull(
  roles: string[],
  permissions: string[] = [],
): { authz: AuthzService; calls: { roles: number; permissions: number } } {
  const calls = { roles: 0, permissions: 0 };
  const authz = {
    effectiveRoles: async () => {
      calls.roles += 1;
      return roles;
    },
    effectivePermissions: async () => {
      calls.permissions += 1;
      return permissions;
    },
  } as unknown as AuthzService;
  return { authz, calls };
}

/** ctx mínimo que registra qual método de resposta foi chamado. */
function fakeCtx(user: unknown) {
  const calls: { redirect?: string; forbidden?: unknown; unauthorized?: unknown } = {};
  const ctx = {
    auth: { getUser: async () => user },
    response: {
      redirect: (url: string) => {
        calls.redirect = url;
      },
      forbidden: (body?: unknown) => {
        calls.forbidden = body ?? true;
      },
      unauthorized: (body?: unknown) => {
        calls.unauthorized = body ?? true;
      },
    },
  };
  return { ctx: ctx as never, calls };
}

const noopNext = (async () => {}) as never;

describe('AuthzRoleMiddleware', () => {
  it('chama next quando o usuário tem um dos papéis', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz(['COORDINATOR']));
    const { ctx, calls } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['COORDINATOR'] },
    );
    expect(nexted).toBe(true);
    expect(calls.forbidden).toBeUndefined();
    expect(calls.unauthorized).toBeUndefined();
  });

  it('responde 403 quando o usuário está autenticado mas sem o papel', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz(['ADVISEE']));
    const { ctx, calls } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['COORDINATOR'] },
    );
    expect(nexted).toBe(false);
    expect(calls.forbidden).toBeDefined();
    expect(calls.redirect).toBeUndefined();
  });

  it('redireciona no deniedRedirect quando falta o papel e há redirect', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz([]));
    const { ctx, calls } = fakeCtx({ id: '1' });
    await mw.handle(ctx, noopNext, { roles: ['ADMIN'], deniedRedirect: '/unauthorized' });
    expect(calls.redirect).toBe('/unauthorized');
    expect(calls.forbidden).toBeUndefined();
  });

  it('responde 401 quando não autenticado (sem guestRedirect)', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz([]));
    const { ctx, calls } = fakeCtx(null);
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['COORDINATOR'] },
    );
    expect(nexted).toBe(false);
    expect(calls.unauthorized).toBeDefined();
    expect(calls.redirect).toBeUndefined();
  });

  it('redireciona no guestRedirect quando não autenticado e configurado', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz([]));
    const { ctx, calls } = fakeCtx(null);
    await mw.handle(ctx, noopNext, { roles: ['COORDINATOR'], guestRedirect: '/auth/login' });
    expect(calls.redirect).toBe('/auth/login');
    expect(calls.unauthorized).toBeUndefined();
  });

  it('any-of: passa se tiver PELO MENOS UM dos papéis', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz(['ADMIN']));
    const { ctx } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['ADVISOR', 'ADMIN'] },
    );
    expect(nexted).toBe(true);
  });
});

describe('AuthzRoleMiddleware — abertura por permissão (issue #76)', () => {
  it('abre a rota por permissão com curinga', async () => {
    const { authz } = fakeAuthzFull([], ['admin.users', 'reports.view']);
    const mw = new AuthzRoleMiddleware(authz);
    const { ctx } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { permissions: ['admin.*'] },
    );
    expect(nexted).toBe(true);
  });

  it('o curinga também pode estar na CONCESSÃO (grant `admin.*` abre rota `admin.users`)', async () => {
    const { authz } = fakeAuthzFull([], ['admin.*']);
    const mw = new AuthzRoleMiddleware(authz);
    const { ctx } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { permissions: ['admin.users'] },
    );
    expect(nexted).toBe(true);
  });

  it('nega quando nenhuma permissão casa', async () => {
    const { authz } = fakeAuthzFull(['VISITOR'], ['reports.view']);
    const mw = new AuthzRoleMiddleware(authz);
    const { ctx, calls } = fakeCtx({ id: '1' });
    await mw.handle(ctx, noopNext, { permissions: ['admin.*'] });
    expect(calls.forbidden).toBeDefined();
  });

  it('os papéis bastam: as permissões nem são lidas (lazy)', async () => {
    const { authz, calls } = fakeAuthzFull(['ADMIN'], ['posts.edit']);
    const mw = new AuthzRoleMiddleware(authz);
    const { ctx } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['ADMIN'], permissions: ['posts.edit'] },
    );
    expect(nexted).toBe(true);
    expect(calls.roles).toBe(1);
    expect(calls.permissions).toBe(0);
  });

  it('papéis sem sorte → as permissões ainda salvam a rota', async () => {
    const { authz, calls } = fakeAuthzFull(['EDITOR'], ['posts.edit']);
    const mw = new AuthzRoleMiddleware(authz);
    const { ctx } = fakeCtx({ id: '1' });
    let nexted = false;
    await mw.handle(
      ctx,
      (async () => {
        nexted = true;
      }) as never,
      { roles: ['ADMIN'], permissions: ['posts.edit'] },
    );
    expect(nexted).toBe(true);
    expect(calls.permissions).toBe(1);
  });

  it('onDenied decide a resposta e recebe o que foi resolvido', async () => {
    const { authz } = fakeAuthzFull(['VISITOR'], ['reports.view']);
    const mw = new AuthzRoleMiddleware(authz);
    const { ctx, calls } = fakeCtx({ id: '1' });
    let seen: { roles: string[]; permissions: string[] } | undefined;
    const verdict = await mw.handle(ctx, noopNext, {
      roles: ['ADMIN'],
      permissions: ['admin.*'],
      onDenied: (_ctx: unknown, effective: { roles: string[]; permissions: string[] }) => {
        seen = effective;
        return 'denied-by-host';
      },
    });
    expect(verdict).toBe('denied-by-host');
    expect(seen).toEqual({ roles: ['VISITOR'], permissions: ['reports.view'] });
    // O hook substitui a resposta default: nada de 403/redirect do middleware.
    expect(calls.forbidden).toBeUndefined();
    expect(calls.redirect).toBeUndefined();
  });

  it('sem roles nem permissions é erro de configuração', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz([]));
    const { ctx } = fakeCtx({ id: '1' });
    await expect(mw.handle(ctx, noopNext, {})).rejects.toThrow(/roles.*permissions|permissions/);
  });

  it('roles continua obrigatório na prática: arrays vazios contam como ausentes', async () => {
    const mw = new AuthzRoleMiddleware(fakeAuthz(['ADMIN']));
    const { ctx } = fakeCtx({ id: '1' });
    await expect(mw.handle(ctx, noopNext, { roles: [], permissions: [] })).rejects.toThrow(
      /at least one/,
    );
  });
});
