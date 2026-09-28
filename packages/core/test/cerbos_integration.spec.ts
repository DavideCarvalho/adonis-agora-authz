import { HTTP } from '@cerbos/http';
import { describe, expect, it } from 'vitest';
import { AuthzService } from '../src/authz_service.js';
import { CerbosDecisionProvider } from '../src/cerbos/index.js';
import { applyScopeConstraint, type ScopeableQuery } from '../src/lucid_scope.js';
import { eq, ScopeRegistry } from '../src/scope.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

/**
 * Against a REAL Cerbos PDP loaded with `test/fixtures/cerbos/*.yaml`:
 *
 *   docker run --rm -d --name authz-cerbos -p 3592:3592 \
 *     -v "$PWD/test/fixtures/cerbos:/policies:ro" ghcr.io/cerbos/cerbos:0.55.0 server
 *   CERBOS_TEST_URL=http://127.0.0.1:3592 pnpm vitest run test/cerbos_integration.spec.ts
 *
 * Skipped when `CERBOS_TEST_URL` is not set (the default `pnpm test` needs no Docker).
 */
const url = process.env.CERBOS_TEST_URL;
const describeCerbos = url ? describe : describe.skip;

class Doc {
  constructor(
    readonly id: string,
    readonly owner: string,
    readonly status = 'draft',
  ) {}
}

class User {
  constructor(readonly id: string) {}
}

describeCerbos('CerbosDecisionProvider against a real Cerbos PDP', () => {
  const provider = new CerbosDecisionProvider({
    client: new HTTP(url ?? 'http://127.0.0.1:3592'),
    principal: (_user, { ref }) => (ref ? { id: ref.id, roles: ['user'] } : undefined),
    resource: (_ability, r) =>
      r instanceof Doc
        ? { kind: 'doc', id: r.id, attr: { owner: r.owner, status: r.status } }
        : undefined,
    scope: { resource: (model) => (model === Doc ? { kind: 'doc' } : undefined) },
  });

  async function authz(): Promise<AuthzService> {
    const store = new MemoryPermissionStore();
    // An RBAC grant that would allow everything on docs — proves Cerbos' verdict wins.
    await store.givePermissionToRole('writer', '*');
    await store.assignRole({ type: 'user', id: 'u2' }, 'writer');
    const scopes = new ScopeRegistry().register(Doc, () => eq('never', 'used'));
    return new AuthzService({ store, scopes, decisionProvider: provider });
  }

  it('allows / denies single checks (Cerbos overrides a permissive RBAC grant)', async () => {
    const service = await authz();
    expect(await service.can(new User('u1'), 'update', { resource: new Doc('d1', 'u1') })).toBe(
      true,
    );
    expect(await service.can(new User('u2'), 'update', { resource: new Doc('d1', 'u1') })).toBe(
      false,
    );
    expect(await service.can(new User('u2'), 'read', { resource: new Doc('d1', 'u1') })).toBe(true);
    // A model-less permission is not governed by Cerbos → abstain → RBAC (`*`) decides.
    expect(await service.check(new User('u2'), 'reports.export')).toEqual({
      allowed: true,
      reason: 'permission',
    });
  });

  it('batches canMany into one CheckResources call', async () => {
    const service = await authz();
    const results = await service.canMany(new User('u1'), [
      { permission: 'update', resource: new Doc('a', 'u1') },
      { permission: 'update', resource: new Doc('b', 'u2') },
      { permission: 'delete', resource: new Doc('a', 'u1') },
      { permission: 'delete', resource: new Doc('c', 'u1', 'published') },
    ]);
    expect(results).toEqual([true, false, true, false]);
  });

  it('maps PlanResources onto authz.scope()', async () => {
    const service = await authz();
    const user = new User('u1');
    expect(await service.scope(user, Doc, { action: 'read' })).toEqual({ kind: 'all' });
    expect(await service.scope(user, Doc, { action: 'update' })).toEqual({
      kind: 'condition',
      field: 'owner',
      op: 'eq',
      value: 'u1',
    });
    expect(await service.scope(user, Doc, { action: 'delete' })).toEqual({
      kind: 'and',
      nodes: [
        { kind: 'condition', field: 'owner', op: 'eq', value: 'u1' },
        { kind: 'condition', field: 'status', op: 'ne', value: 'published' },
      ],
    });
    // An action with no rule → always denied.
    expect(await service.scope(user, Doc, { action: 'archive' })).toEqual({ kind: 'none' });
  });

  it('the planned scope filters real rows through applyScopeConstraint', async () => {
    const db = makeMemoryDatabase();
    try {
      const lucid = asLucidDatabase(db);
      await lucid.rawQuery('CREATE TABLE docs (id TEXT PRIMARY KEY, owner TEXT, status TEXT)');
      await lucid.rawQuery(
        "INSERT INTO docs VALUES ('a','u1','draft'),('b','u2','draft'),('c','u1','published')",
      );
      const service = await authz();
      const constraint = await service.scope(new User('u1'), Doc, { action: 'delete' });
      const query = db.from('docs').select('id').orderBy('id');
      applyScopeConstraint(query as unknown as ScopeableQuery, constraint);
      const rows = (await query) as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(['a']);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('fails closed when the PDP is unreachable', async () => {
    const down = new CerbosDecisionProvider({
      client: new HTTP('http://127.0.0.1:1'),
      principal: () => ({ id: 'u1', roles: ['user'] }),
      resource: (_a, r) => (r instanceof Doc ? { kind: 'doc', id: r.id } : undefined),
    });
    expect(
      await down.decide(new User('u1'), 'read', new Doc('d', 'u1'), {
        ref: { type: 'user', id: 'u1' },
        tenant: undefined,
      }),
    ).toBe(false);
  });
});
