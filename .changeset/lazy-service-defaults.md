---
'@adonis-agora/authz': minor
---

**The service singleton is the way in.** `import authz from '@adonis-agora/authz/services/main'`
now carries the whole service — the decisions, the `store` (with `withClient`) and `createCache()` —
resolved from the container on the first call, so it works from controllers, commands, models and
config alike. `defineAuthzAbilities()` and `hasPermissions()` use it by default: the published
`app/abilities/authz.ts` is one line and a model is
`compose(BaseModel, hasPermissions())` — no `app` import, no top-level `container.make`. Passing a
service/resolver still overrides (tests). `registerCanEndpoint` accepts the singleton.
`AuthzService.effectiveRolesForRef(ref, tenant)` is public. Removed: `authzAbilities()` (redundant
with the no-argument `defineAuthzAbilities()`).

Docs rewritten around real Adonis call sites (controllers, commands, models) instead of container
plumbing.
