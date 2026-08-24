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

const authkitLike = { getUser: () => Promise.resolve(new User('u1')) };
const adonisAuthLike = { user: new User('u2') };
const anonymousLike = { getUser: () => Promise.resolve(null) };

describe('authorizeByRoles', () => {
  beforeEach(() => {
    makeSpy.mockReset();
  });

  it('permite quando o usuário tem uma das roles (authkit getUser)', async () => {
    const { store, service } = makeService();
    await store.assignRole({ type: 'user', id: 'u1' }, 'ADMIN');
    makeSpy.mockReturnValue(service);

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(authkitLike))).resolves.toBe(true);
    expect(makeSpy).toHaveBeenCalledWith(AuthzService);
  });

  it('permite quando o usuário tem uma das roles (adonis auth .user)', async () => {
    const { store } = makeService();
    await store.assignRole({ type: 'user', id: 'u2' }, 'EDITOR');
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN', 'EDITOR'] });
    await expect(authorize(makeCtx(adonisAuthLike))).resolves.toBe(true);
  });

  it('nega quando o usuário não tem nenhuma das roles', async () => {
    const { store } = makeService();
    await store.assignRole({ type: 'user', id: 'u1' }, 'ADVISEE');
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(authkitLike))).resolves.toBe(false);
  });

  it('nega usuário anônimo', async () => {
    const { store } = makeService();
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(anonymousLike))).resolves.toBe(false);
  });

  it('nega quando não há ctx.auth', async () => {
    const { store } = makeService();
    makeSpy.mockReturnValue(new AuthzService({ store }));

    const authorize = authorizeByRoles({ roles: ['ADMIN'] });
    await expect(authorize(makeCtx(undefined))).resolves.toBe(false);
  });
});
