import type {
  DecisionContext,
  DecisionProvider,
  DecisionRequest,
  DecisionVerdict,
} from '../decision_provider.js';
import { type ResourceKey, type ScopeConstraint, scopeNone } from '../scope.js';
import { type CerbosFieldMapper, type CerbosPlanLike, cerbosPlanToScope } from './plan.js';

/** A Cerbos attribute value (JSON). */
export type CerbosValue =
  | string
  | number
  | boolean
  | null
  | CerbosValue[]
  | { [key: string]: CerbosValue };

/** The principal sent to Cerbos. */
export interface CerbosPrincipal {
  id: string;
  roles: string[];
  attr?: Record<string, CerbosValue>;
  policyVersion?: string;
  scope?: string;
}

/** A resource sent to Cerbos `CheckResources`. */
export interface CerbosResource {
  kind: string;
  id: string;
  attr?: Record<string, CerbosValue>;
  policyVersion?: string;
  scope?: string;
}

/** The resource query sent to Cerbos `PlanResources` (a resource without an id). */
export type CerbosResourceQuery = Omit<CerbosResource, 'id'>;

/**
 * The slice of a Cerbos SDK client the adapter uses. `@cerbos/http`'s `HTTP` and `@cerbos/grpc`'s
 * `GRPC` satisfy it structurally, so this package does not depend on either.
 */
export interface CerbosClientLike {
  checkResources(request: {
    principal: CerbosPrincipal;
    resources: Array<{ resource: CerbosResource; actions: string[] }>;
  }): Promise<{
    isAllowed(check: {
      resource: { kind: string; id: string; policyVersion?: string; scope?: string };
      action: string;
    }): boolean | undefined;
  }>;
  planResources?(request: {
    principal: CerbosPrincipal;
    resource: CerbosResourceQuery;
    action: string;
  }): Promise<CerbosPlanLike>;
}

type Awaitable<T> = T | Promise<T>;

export interface CerbosDecisionProviderOptions {
  /**
   * The Cerbos client, or a per-user resolver (e.g. per-tenant PDPs). Resolving `undefined`
   * ABSTAINS — the service falls back to its own rules (RBAC) for that user.
   */
  client:
    | CerbosClientLike
    | ((user: unknown, context: DecisionContext) => Awaitable<CerbosClientLike | undefined>);
  /**
   * Build the Cerbos principal from the host user (and the mapped ref / active tenant in
   * `context`). `undefined` (e.g. anonymous) abstains.
   */
  principal: (user: unknown, context: DecisionContext) => Awaitable<CerbosPrincipal | undefined>;
  /**
   * Map a check to a Cerbos resource. `undefined` abstains — use it for abilities/resources
   * Cerbos does not govern (model-less permissions, other resource types).
   */
  resource: (
    ability: string,
    resource: unknown,
    context: DecisionContext,
  ) => CerbosResource | undefined;
  /** Map an ability/permission to a Cerbos action. Default: the ability name itself. */
  action?: (ability: string) => string;
  /**
   * Query-plan support for `authz.scope(user, Model, { action })` / `accessibleBy`. `resource`
   * names the Cerbos resource kind (and optional attrs/scope) for a resource key (a Lucid model
   * class or a string name) — `undefined` abstains. `field` maps a resource attribute (`owner`,
   * or `id`) to the column `accessibleBy` filters on (default: a plain attribute as-is, nested
   * attributes rejected — see {@link CerbosFieldMapper}).
   */
  scope?: {
    resource: (
      resource: ResourceKey,
      ability: string,
      context: DecisionContext,
    ) => CerbosResourceQuery | undefined;
    field?: CerbosFieldMapper;
  };
  /**
   * What an engine failure (network error, timeout, unsupported query plan) resolves to:
   * `'deny'` (default — fail CLOSED: an outage must not widen access; scopes become deny-all) or
   * `'abstain'` (fall back to the service's own rules).
   */
  onFailure?: 'deny' | 'abstain';
  /** Observe engine failures (logging/metrics). Never affects the verdict. */
  onError?: (error: unknown, context: { phase: 'check' | 'plan'; ability: string }) => void;
  /** Max resources per `CheckResources` call (Cerbos' default server limit is 50). */
  maxBatchSize?: number;
}

const resourceKey = (r: CerbosResource): string =>
  JSON.stringify([r.kind, r.id, r.policyVersion ?? null, r.scope ?? null]);

/**
 * A {@link DecisionProvider} backed by a [Cerbos](https://cerbos.dev) policy decision point:
 * `authz.can` / the Bouncer `can` ability → `CheckResources` (batched for `authz.canMany`),
 * `authz.scope` / `accessibleBy` → `PlanResources` mapped onto the scope AST (see
 * {@link cerbosPlanToScope}).
 *
 * ```ts
 * // config/authz.ts
 * import { HTTP } from '@cerbos/http'
 * import { CerbosDecisionProvider } from '@adonis-agora/authz/cerbos'
 *
 * export default defineConfig({
 *   // ...
 *   decisionProvider: new CerbosDecisionProvider({
 *     client: new HTTP(env.get('CERBOS_URL')),
 *     principal: (user, { ref }) =>
 *       ref && { id: ref.id, roles: (user as User).roles, attr: { tenantId: (user as User).tenantId } },
 *     resource: (_ability, post) =>
 *       post instanceof Post ? { kind: 'app:post', id: String(post.id), attr: { owner: post.ownerId } } : undefined,
 *     scope: {
 *       resource: (model) => (model === Post ? { kind: 'app:post' } : undefined),
 *       field: (attribute) => ({ owner: 'owner_id', id: 'id' })[attribute],
 *     },
 *   }),
 * })
 * ```
 */
export class CerbosDecisionProvider implements DecisionProvider {
  private readonly failureVerdict: DecisionVerdict;
  private readonly maxBatchSize: number;

  constructor(private readonly options: CerbosDecisionProviderOptions) {
    this.failureVerdict = options.onFailure === 'abstain' ? undefined : false;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 50);
  }

  private action(ability: string): string {
    return this.options.action ? this.options.action(ability) : ability;
  }

  private async client(
    user: unknown,
    context: DecisionContext,
  ): Promise<CerbosClientLike | undefined> {
    const { client } = this.options;
    return typeof client === 'function' ? client(user, context) : client;
  }

  private fail(error: unknown, phase: 'check' | 'plan', ability: string): void {
    try {
      this.options.onError?.(error, { phase, ability });
    } catch {
      // An observer must never change the verdict.
    }
  }

  async decide(
    user: unknown,
    ability: string,
    resource: unknown,
    context: DecisionContext = { ref: undefined, tenant: undefined },
  ): Promise<DecisionVerdict> {
    const [verdict] = await this.decideMany(
      user,
      resource === undefined ? [{ ability }] : [{ ability, resource }],
      context,
    );
    return verdict;
  }

  async decideMany(
    user: unknown,
    requests: DecisionRequest[],
    context: DecisionContext = { ref: undefined, tenant: undefined },
  ): Promise<DecisionVerdict[]> {
    const verdicts: DecisionVerdict[] = requests.map(() => undefined);
    const mapped = requests.map((r) => {
      const resource = this.options.resource(r.ability, r.resource, context);
      return resource ? { resource, action: this.action(r.ability) } : undefined;
    });
    if (mapped.every((m) => m === undefined)) return verdicts;

    const client = await this.client(user, context);
    if (!client) return verdicts;
    const principal = await this.options.principal(user, context);
    if (!principal) return verdicts;

    // One ResourceCheck per distinct resource, carrying every action asked about it.
    const checks = new Map<string, { resource: CerbosResource; actions: Set<string> }>();
    for (const m of mapped) {
      if (!m) continue;
      const key = resourceKey(m.resource);
      const entry = checks.get(key) ?? { resource: m.resource, actions: new Set<string>() };
      entry.actions.add(m.action);
      checks.set(key, entry);
    }

    const all = [...checks.values()];
    const answers = new Map<string, boolean | undefined>();
    for (let i = 0; i < all.length; i += this.maxBatchSize) {
      const chunk = all.slice(i, i + this.maxBatchSize);
      try {
        const response = await client.checkResources({
          principal,
          resources: chunk.map((c) => ({ resource: c.resource, actions: [...c.actions] })),
        });
        for (const c of chunk) {
          for (const action of c.actions) {
            answers.set(
              `${resourceKey(c.resource)}|${action}`,
              response.isAllowed({ resource: c.resource, action }),
            );
          }
        }
      } catch (error) {
        this.fail(error, 'check', requests[0]?.ability ?? '');
        for (const c of chunk) {
          for (const action of c.actions) {
            answers.set(`${resourceKey(c.resource)}|${action}`, undefined);
          }
        }
      }
    }

    for (const [index, m] of mapped.entries()) {
      if (!m) continue;
      const answer = answers.get(`${resourceKey(m.resource)}|${m.action}`);
      // No answer for a resource we asked about = engine failure → the failure mode.
      verdicts[index] = answer === undefined ? this.failureVerdict : answer;
    }
    return verdicts;
  }

  async planScope(
    user: unknown,
    resource: ResourceKey,
    ability: string,
    context: DecisionContext = { ref: undefined, tenant: undefined },
  ): Promise<ScopeConstraint | undefined> {
    const scope = this.options.scope;
    if (!scope) return undefined;
    const query = scope.resource(resource, ability, context);
    if (!query) return undefined;
    const client = await this.client(user, context);
    if (!client || typeof client.planResources !== 'function') return undefined;
    const principal = await this.options.principal(user, context);
    if (!principal) return undefined;
    try {
      const plan = await client.planResources({
        principal,
        resource: query,
        action: this.action(ability),
      });
      return cerbosPlanToScope(plan, scope.field);
    } catch (error) {
      this.fail(error, 'plan', ability);
      return this.failureVerdict === undefined ? undefined : scopeNone;
    }
  }
}
