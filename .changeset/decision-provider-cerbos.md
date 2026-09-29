---
'@adonis-agora/authz': minor
---

External policy engines: a new `DecisionProvider` seam (`decisionProvider` in `config/authz.ts`) and a Cerbos adapter at `@adonis-agora/authz/cerbos`.

- `DecisionProvider.decide(user, permission, resource, { ref, tenant })` can **allow, deny or abstain**. It runs right after the super-admin check (`superAdmin` hook / `superAdminRoles`) and before the RBAC grants. It is also consulted for anonymous callers. Role checks (`hasRole`/`hasAnyRole`) are unchanged.
- `authz.can(user, permission, { resource })` accepts the resource; the Bouncer `can` ability forwards its resource argument and surfaces a provider's deny message.
- New `authz.check(...)` → `{ allowed, reason, message? }`, and batch `authz.canMany(...)` / `authz.checkMany(...)`: one `decideMany` round-trip per batch, falling back to per-item `decide` if the batch call fails.
- Optional `planScope(user, resourceKey, action, ctx)` feeds `authz.scope()` / `accessibleBy` right after super-admin; `undefined` abstains.
- The `superAdmin` hook now receives the resource as a third argument (the checked resource, or the resource key for `scope`). This is additive.
- `@adonis-agora/authz/cerbos`: `CerbosDecisionProvider` (per-user/per-tenant clients, batching with de-duplication and chunking, fails closed by default, `onFailure: 'abstain'` opt-out) and `cerbosPlanToScope` (Cerbos `PlanResources` → scope AST: and/or, `not` via De Morgan, eq/ne/lt/gt/le/ge/in, null checks; nested attributes must be mapped explicitly; anything else is rejected, which fails closed). Structural client types — no runtime dependency on the Cerbos SDKs.
