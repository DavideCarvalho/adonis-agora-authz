import { describe, expect, it, vi } from 'vitest';
import {
  type CerbosClientLike,
  CerbosDecisionProvider,
  type CerbosDecisionProviderOptions,
} from '../src/cerbos/index.js';
import type { DecisionContext } from '../src/decision_provider.js';
import { scopeAll, scopeNone } from '../src/scope.js';

class Doc {
  constructor(
    readonly id: string,
    readonly owner: string,
  ) {}
}

const ctx: DecisionContext = { ref: undefined, tenant: undefined };

/** A fake Cerbos: allows `read` on everything, anything else only for the owner. */
function fakeClient() {
  const checkResources = vi.fn(async (req: Parameters<CerbosClientLike['checkResources']>[0]) => ({
    isAllowed: ({ resource, action }: { resource: { id: string }; action: string }) => {
      const r = req.resources.find((c) => c.resource.id === resource.id);
      if (!r || !r.actions.includes(action)) return undefined;
      return action === 'read' || r.resource.attr?.owner === req.principal.id;
    },
  }));
  const planResources = vi.fn(async () => ({
    kind: 'KIND_CONDITIONAL',
    condition: {
      operator: 'eq',
      operands: [{ name: 'request.resource.attr.owner' }, { value: 'u1' }],
    },
  }));
  return { checkResources, planResources } satisfies CerbosClientLike;
}

function provider(overrides: Partial<CerbosDecisionProviderOptions> = {}) {
  const client = fakeClient();
  const p = new CerbosDecisionProvider({
    client,
    principal: (u) => (u ? { id: (u as { id: string }).id, roles: ['user'] } : undefined),
    resource: (_ability, r) =>
      r instanceof Doc ? { kind: 'doc', id: r.id, attr: { owner: r.owner } } : undefined,
    scope: { resource: (model) => (model === Doc ? { kind: 'doc' } : undefined) },
    ...overrides,
  });
  return { p, client };
}

describe('CerbosDecisionProvider', () => {
  it('decides allow/deny through CheckResources', async () => {
    const { p } = provider();
    expect(await p.decide({ id: 'u1' }, 'update', new Doc('d1', 'u1'), ctx)).toBe(true);
    expect(await p.decide({ id: 'u2' }, 'update', new Doc('d1', 'u1'), ctx)).toBe(false);
  });

  it('abstains for unmapped resources, anonymous users and unresolved clients', async () => {
    const { p, client } = provider();
    expect(await p.decide({ id: 'u1' }, 'posts.publish', undefined, ctx)).toBeUndefined();
    expect(await p.decide(undefined, 'update', new Doc('d1', 'u1'), ctx)).toBeUndefined();
    const perTenant = provider({ client: () => undefined }).p;
    expect(
      await perTenant.decide({ id: 'u1' }, 'update', new Doc('d1', 'u1'), ctx),
    ).toBeUndefined();
    expect(client.checkResources).toHaveBeenCalledTimes(0);
  });

  it('hands the decision context (ref + tenant) to the client resolver and mappers', async () => {
    const { client } = provider();
    const resolve = vi.fn().mockReturnValue(client);
    const principal = vi.fn().mockReturnValue({ id: 'u1', roles: ['user'] });
    const p = provider({ client: resolve, principal }).p;
    const context: DecisionContext = { ref: { type: 'user', id: 'u1' }, tenant: { tenantId: 't' } };
    await p.decide({ id: 'u1' }, 'read', new Doc('d', 'u1'), context);
    expect(resolve).toHaveBeenCalledWith({ id: 'u1' }, context);
    expect(principal).toHaveBeenCalledWith({ id: 'u1' }, context);
  });

  it('decideMany: one request, resources de-duplicated with merged actions, order kept', async () => {
    const { p, client } = provider();
    const d1 = new Doc('d1', 'u1');
    const verdicts = await p.decideMany(
      { id: 'u2' },
      [
        { ability: 'read', resource: d1 },
        { ability: 'update', resource: d1 },
        { ability: 'posts.publish' },
        { ability: 'update', resource: new Doc('d2', 'u2') },
      ],
      ctx,
    );
    expect(verdicts).toEqual([true, false, undefined, true]);
    expect(client.checkResources).toHaveBeenCalledOnce();
    const req = client.checkResources.mock.calls[0]?.[0];
    expect(req?.resources).toEqual([
      { resource: { kind: 'doc', id: 'd1', attr: { owner: 'u1' } }, actions: ['read', 'update'] },
      { resource: { kind: 'doc', id: 'd2', attr: { owner: 'u2' } }, actions: ['update'] },
    ]);
  });

  it('chunks large batches by maxBatchSize', async () => {
    const { p, client } = provider({ maxBatchSize: 2 });
    const docs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      ability: 'read',
      resource: new Doc(id, 'x'),
    }));
    expect(await p.decideMany({ id: 'u' }, docs, ctx)).toEqual([true, true, true, true, true]);
    expect(client.checkResources).toHaveBeenCalledTimes(3);
  });

  it('fails CLOSED by default on engine errors, and reports them', async () => {
    const onError = vi.fn();
    const failing = { checkResources: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const { p } = provider({ client: failing, onError });
    expect(await p.decide({ id: 'u1' }, 'read', new Doc('d', 'u1'), ctx)).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: 'check', ability: 'read' });

    const lenient = provider({ client: failing, onFailure: 'abstain' }).p;
    expect(await lenient.decide({ id: 'u1' }, 'read', new Doc('d', 'u1'), ctx)).toBeUndefined();
  });

  it('an observer that throws never changes the verdict', async () => {
    const failing = { checkResources: vi.fn().mockRejectedValue(new Error('down')) };
    const onError = () => {
      throw new Error('observer bug');
    };
    const { p } = provider({ client: failing, onError });
    expect(await p.decide({ id: 'u1' }, 'read', new Doc('d', 'u1'), ctx)).toBe(false);
  });

  it('maps the ability to a Cerbos action', async () => {
    const { p, client } = provider({ action: (a) => (a === 'view' ? 'read' : a) });
    expect(await p.decide({ id: 'u2' }, 'view', new Doc('d', 'u1'), ctx)).toBe(true);
    expect(client.checkResources.mock.calls[0]?.[0].resources[0]?.actions).toEqual(['read']);
  });

  it('planScope maps PlanResources onto the scope AST', async () => {
    const { p, client } = provider();
    expect(await p.planScope({ id: 'u1' }, Doc, 'read', ctx)).toEqual({
      kind: 'condition',
      field: 'owner',
      op: 'eq',
      value: 'u1',
    });
    expect(client.planResources).toHaveBeenCalledWith({
      principal: { id: 'u1', roles: ['user'] },
      resource: { kind: 'doc' },
      action: 'read',
    });
    class Other {}
    expect(await p.planScope({ id: 'u1' }, Other, 'read', ctx)).toBeUndefined();
    expect(await p.planScope({ id: 'u1' }, 'posts', 'read', ctx)).toBeUndefined();
  });

  it('planScope abstains without a scope config or a planResources-capable client', async () => {
    const { client } = provider();
    const noScope = new CerbosDecisionProvider({
      client,
      principal: () => ({ id: 'u1', roles: [] }),
      resource: () => undefined,
    });
    expect(await noScope.planScope({ id: 'u1' }, Doc, 'read', ctx)).toBeUndefined();
    const checkOnly = provider({ client: { checkResources: client.checkResources } }).p;
    expect(await checkOnly.planScope({ id: 'u1' }, Doc, 'read', ctx)).toBeUndefined();
  });

  it('planScope fails closed (deny-all) on an unsupported plan or an error', async () => {
    const onError = vi.fn();
    const client = {
      checkResources: vi.fn(),
      planResources: vi.fn().mockResolvedValue({
        kind: 'KIND_CONDITIONAL',
        condition: { operator: 'add', operands: [] },
      }),
    };
    const { p } = provider({ client, onError });
    expect(await p.planScope({ id: 'u1' }, Doc, 'read', ctx)).toBe(scopeNone);
    expect(onError).toHaveBeenCalledOnce();

    client.planResources.mockResolvedValue({ kind: 'KIND_ALWAYS_ALLOWED' });
    expect(await p.planScope({ id: 'u1' }, Doc, 'read', ctx)).toBe(scopeAll);

    const lenient = provider({ client, onFailure: 'abstain' }).p;
    client.planResources.mockRejectedValue(new Error('down'));
    expect(await lenient.planScope({ id: 'u1' }, Doc, 'read', ctx)).toBeUndefined();
  });
});
