---
"@adonis-agora/authz": minor
---

**BREAKING:** `authorizeByRoles` now returns an `AuthorizeResult` instead of a bare `boolean`, so dashboards can tell "no session" (`401`) from "signed in without the role" (`403`). Before, a signed-in user without `ADMIN` opening the telescope console got "401 — Sign in required".

- has one of `roles` → `true`
- no user → `{ allowed: false, reason: 'unauthenticated' }` (the `loginPath` redirect for page navigations is unchanged)
- signed in without any of `roles` → `{ allowed: false, reason: 'forbidden' }`

`AuthorizeDecision` and `AuthorizeResult` are exported from `@adonis-agora/authz`; the hook is typed `(ctx: unknown) => Promise<AuthorizeResult>`.

**Requires the dashboard lib versions that accept `AuthorizeDecision`** (telescope ≥ 0.26.0, durable ≥ 0.56.0, media ≥ 0.28.0, payments ≥ 0.22.0, agent ≥ 0.91.0). The denial is an object, which is truthy: an older dashboard that does `if (!(await authorize(ctx)))` would let a denied request through. Those older versions type `authorize` as `(ctx) => boolean | Promise<boolean>`, so pairing them with this release fails the app's typecheck (`Type 'AuthorizeDecision' is not assignable to type 'boolean'`) — upgrade the dashboards; do not cast the error away. Hand-written hooks that call `authorizeByRoles` and treat its result as a boolean must switch to `result === true || (typeof result === 'object' && result.allowed)`.
