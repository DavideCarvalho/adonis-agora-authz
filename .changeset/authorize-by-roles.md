---
'@adonis-agora/authz': minor
---

Add `authorizeByRoles({ roles, scope? })` — a factory for dashboard `authorize` hooks.

Same semantics as the `requireRole` middleware, in the `(ctx) => boolean` shape the
`@adonis-agora` dashboards (telescope, durable, media, agent) expect:

```ts
// config/telescope_ui.ts
import { defineConfig } from '@adonis-agora/telescope/ui'
import { authorizeByRoles } from '@adonis-agora/authz'

export default defineConfig({
  authorize: authorizeByRoles({ roles: ['ADMIN'] }),
})
```

- Resolves the user from `ctx.auth.getUser()` (authkit) or `ctx.auth.user` (any guard) —
  works with or without authkit.
- Checks `effectiveRoles` (global token claims ∪ app-level DB roles); `roles` is any-of.
- No authenticated user → `false` (the dashboard guard answers 401/403 or honors a redirect).
- Accepts any context shape structurally (dashboards type `authorize` differently), never
  touching AdonisJS internals — so one RBAC gate reads the same across every dashboard.

Also exported: `AuthorizeByRolesOptions` type.
