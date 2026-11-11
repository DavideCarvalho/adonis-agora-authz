import { afterEach, describe, expect, it } from 'vitest';
import { AGORA_CONTEXT_ACCESSOR } from '../src/agora/context.js';
import { AuthzService } from '../src/authz_service.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

/**
 * The request context's `globalRoles` belong to the request's caller (the token's subject).
 * They must never leak into the roles authz resolves for ANOTHER subject asked about in the same
 * request: an admin listing users, an admin's request minting a token for someone else, or an
 * impersonation.
 */

type Slots = Record<symbol, unknown>;

/** A request made by `caller`, holding `globalRoles` from its token (what authkit writes). */
function inRequestOf(caller: { type?: string; id: string } | undefined, globalRoles: string[]) {
  const store = { ...(caller ? { userRef: { type: 'user', ...caller } } : {}), globalRoles };
  (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR] = { get: () => store };
}

afterEach(() => {
  delete (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR];
});

async function setup() {
  const store = new MemoryPermissionStore();
  await store.assignRole({ type: 'user', id: 'researcher' }, 'RESEARCHER');
  await store.givePermissionToRole('RESEARCHER', 'papers.read');
  const authz = new AuthzService({
    store,
    superAdminRoles: ['ADMIN'],
    roleGrants: { ADMIN: ['admin.*'] },
  });
  return { store, authz };
}

describe('context global roles stay with the request caller', () => {
  it("an admin's request asking for another user's roles gets only that user's roles", async () => {
    const { authz } = await setup();
    inRequestOf({ id: 'admin' }, ['ADMIN']);

    expect(await authz.effectiveRoles({ id: 'researcher' })).toEqual(['RESEARCHER']);
    expect(await authz.effectivePermissions({ id: 'researcher' })).toEqual(['papers.read']);
    expect(await authz.hasRole({ id: 'researcher' }, 'ADMIN')).toBe(false);
    expect(await authz.can({ id: 'researcher' }, 'admin.users.delete')).toBe(false);
    // The caller keeps its own token roles.
    expect(await authz.effectiveRoles({ id: 'admin' })).toEqual(['ADMIN']);
    expect(await authz.can({ id: 'admin' }, 'admin.users.delete')).toBe(true);
  });

  it('the per-request cache keeps the caller and the other subject apart', async () => {
    const { authz } = await setup();
    inRequestOf({ id: 'admin' }, ['ADMIN']);
    const cache = authz.createCache();

    expect(await authz.effectiveRoles({ id: 'admin' }, undefined, { cache })).toEqual(['ADMIN']);
    expect(await authz.effectiveRoles({ id: 'researcher' }, undefined, { cache })).toEqual([
      'RESEARCHER',
    ]);
  });

  it('token exchange: a hook minting roles for another account in an admin request adds no ADMIN', async () => {
    const { authz } = await setup();
    // The shape of authkit's `resolveTokenRoles` in a host that keeps roles in authz.
    const resolveTokenRoles = (account: { id: string }) => authz.effectiveRoles({ id: account.id });

    inRequestOf({ id: 'admin' }, ['ADMIN']);
    expect(await resolveTokenRoles({ id: 'researcher' })).toEqual(['RESEARCHER']);
  });

  it("impersonation: the impersonated user's request carries only that user's roles", async () => {
    const { authz } = await setup();
    // An admin impersonating the researcher: the context is the researcher's session.
    inRequestOf({ id: 'researcher' }, ['RESEARCHER']);

    expect(await authz.effectiveRoles({ id: 'researcher' })).toEqual(['RESEARCHER']);
    expect(await authz.effectiveRoles({ id: 'admin' })).toEqual([]);
    expect(await authz.can({ id: 'admin' }, 'admin.users.delete')).toBe(false);
  });

  it('context roles with no caller ref apply to nobody', async () => {
    const { authz } = await setup();
    inRequestOf(undefined, ['ADMIN']);

    expect(await authz.effectiveRoles({ id: 'researcher' })).toEqual(['RESEARCHER']);
    expect(await authz.can({ id: 'researcher' }, 'admin.users.delete')).toBe(false);
  });

  it('a caller with the same id but another subject type is a different subject', async () => {
    const { authz } = await setup();
    inRequestOf({ type: 'service', id: 'researcher' }, ['ADMIN']);

    expect(await authz.effectiveRoles({ id: 'researcher' })).toEqual(['RESEARCHER']);
  });

  it("reads the caller from the context lib's userRef() accessor", async () => {
    const { authz } = await setup();
    (globalThis as Slots)[AGORA_CONTEXT_ACCESSOR] = {
      userRef: () => ({ type: 'user', id: 'admin' }),
      get: () => ({ globalRoles: ['ADMIN'] }),
    };

    expect(await authz.effectiveRoles({ id: 'admin' })).toEqual(['ADMIN']);
    expect(await authz.effectiveRoles({ id: 'researcher' })).toEqual(['RESEARCHER']);
  });
});
