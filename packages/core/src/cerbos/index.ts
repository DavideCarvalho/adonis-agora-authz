/**
 * `@adonis-agora/authz/cerbos` — a {@link DecisionProvider} backed by a Cerbos PDP. Structural
 * client types only: bring your own `@cerbos/http` / `@cerbos/grpc` client (no runtime dependency
 * here). Plug it in with `decisionProvider` in `config/authz.ts`.
 */

export type {
  DecisionContext,
  DecisionProvider,
  DecisionRequest,
  DecisionVerdict,
} from '../decision_provider.js';
export {
  type CerbosClientLike,
  CerbosDecisionProvider,
  type CerbosDecisionProviderOptions,
  type CerbosPrincipal,
  type CerbosResource,
  type CerbosResourceQuery,
  type CerbosValue,
} from './decision_provider.js';
export {
  type CerbosFieldMapper,
  type CerbosPlanLike,
  type CerbosPlanOperand,
  CerbosPlanUnsupportedError,
  cerbosPlanToScope,
  defaultCerbosFieldMapper,
} from './plan.js';
