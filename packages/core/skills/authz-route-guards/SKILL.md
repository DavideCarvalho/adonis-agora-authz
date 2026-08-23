---
name: authz-route-guards
description: >
  Guard AdonisJS routes with @adonis-agora/authz — AuthzRoleMiddleware
  registered as the named middleware requireRole from the
  @adonis-agora/authz/middleware subpath, any-of roles matching against
  AuthzService.effectiveRoles (global token claim ∪ resolveRoles ∪ store),
  RequireRoleOptions (roles, scope, guestRedirect, deniedRedirect,
  deniedMessage), and where permission checks belong instead (Bouncer can in
  the action, accessibleBy for collections). Use when keeping route trees
  behind a role, redirecting unauthenticated or unauthorized requests in SSR /
  Inertia apps, or wiring start/kernel.ts middleware.
metadata:
  type: core
  library: "@adonis-agora/authz"
  library_version: "0.10.5"
  framework: adonisjs
sources:
  - DavideCarvalho/adonis-authz:docs/middleware.mdx
  - DavideCarvalho/adonis-authz:packages/core/src/middleware.ts
---

# Route guards: requireRole

`AuthzRoleMiddleware` is the "require role X" guard every app otherwise
rewrites by hand. It gates on **effective** roles (global ∪ app ∪ store), so a
token claim, a domain-table role, and a store assignment all satisfy the same
guard. It is deliberately role-only.

## Setup

```ts title="start/kernel.ts"
import router from '@adonisjs/core/services/router'

export const middleware = router.named({
  requireRole: () => import('@adonis-agora/authz/middleware'),
})
```

The user comes from `ctx.auth.getUser()` (authkit) or `ctx.auth.user`
(`@adonisjs/auth`) — either works, neither required. The service arrives via
constructor injection (`@inject()`); no service locator in the flow.

## Core patterns

### Any-of roles per route

```ts title="start/routes.ts"
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

// single role
router
  .get('/coordinator', [CoordinatorController, 'index'])
  .use(middleware.requireRole({ roles: ['COORDINATOR'] }))

// any-of: EITHER role passes
router
  .get('/reports', [ReportsController, 'index'])
  .use(middleware.requireRole({ roles: ['COORDINATOR', 'DIRECTOR'] }))
```

Source: `docs/middleware.mdx`

### Redirect guests and denied users (SSR / Inertia)

Without redirects an unauthenticated request gets `401 { message:
'Unauthenticated' }` and a role miss gets `403 { message: 'Forbidden' }`.

```ts
router
  .group(() => {
    router.get('/admin', [AdminController, 'dashboard'])
  })
  .use(
    middleware.requireRole({
      roles: ['ADMIN'],
      guestRedirect: '/login',
      deniedRedirect: '/unauthorized',
    }),
  )
```

Options: `roles` (required), `scope` (`TenantScope` forwarded to
`effectiveRoles`), `guestRedirect`, `deniedRedirect`, `deniedMessage` (default
`'Forbidden'`).

Source: `docs/middleware.mdx`

### Call the engine directly when you need the union

```ts
import authz from '@adonis-agora/authz/services/main'

const roles = await authz.effectiveRoles(user)                  // global scope
const scoped = await authz.effectiveRoles(user, { tenantId: 'acme' })
```

`effectiveRoles` populates the request's global roles along the way, so
`roles: ['ADMIN']` matches a token claim even with nothing seeded in the store.
Anonymous/unmappable users yield `[]`.

Source: `docs/middleware.mdx`, `docs/roles.mdx`

## Common mistakes

### MEDIUM Using requireRole as a permission gate

There is no permission option — the middleware reads roles only. Forcing
permission checks through it means a hand-rolled duplicate that skips the
effective-role union.

Wrong:

```ts
router.get('/posts', [PostsController, 'index']).use(
  // permissions are not part of RequireRoleOptions
  middleware.requireRole({ roles: [], permission: 'posts.view' } as never),
)
```

Correct:

```ts
router.get('/posts', [PostsController, 'index'])
  .use(middleware.requireRole({ roles: ['EDITOR'] }))
// permission checks live inside the action:
// await ctx.bouncer.authorize('can', 'posts.view')
```

Mechanism: the docs fix the division of labor — roles gate routes, `can`
abilities check permissions in actions, query scopes filter collections.

Source: `docs/middleware.mdx` (closing Callout: "deliberately role-only")

### LOW Seeding store roles to satisfy a token-claim guard

The guard tests effective roles, which already include the token's global
claim; seeding duplicates identity-provider state and creates a second copy to
keep in sync.

Wrong:

```ts
await authz.store.assignRole({ type: 'user', id: '42' }, 'ADMIN'); // redundant
router.get('/admin', ...).use(middleware.requireRole({ roles: ['ADMIN'] }));
```

Correct:

```ts
// the claim alone matches — no seeding:
router.get('/admin', [AdminController, 'dashboard'])
  .use(middleware.requireRole({ roles: ['ADMIN'] }));
```

Mechanism: `effectiveRoles` unions context/global roles on every check, so a
store write adds nothing but drift risk (the same reason the docs forbid
mirroring provider roles into authz tables).

Source: `docs/middleware.mdx`, `docs/bouncer-integration.mdx`

### LOW Omitting guestRedirect/deniedRedirect in browser-facing apps

Without them the middleware answers with raw JSON status bodies — right for
APIs, wrong for server-rendered flows where users expect navigation to /login
or /unauthorized.

Wrong:

```ts
.use(middleware.requireRole({ roles: ['ADMIN'] })) // SSR app → JSON 401/403
```

Correct:

```ts
.use(middleware.requireRole({
  roles: ['ADMIN'],
  guestRedirect: '/login',
  deniedRedirect: '/unauthorized',
}))
```

Mechanism: the defaults are `401 Unauthenticated` / `403 Forbidden` responses;
redirects are opt-in per route.

Source: `docs/middleware.mdx` (RequireRoleOptions table)
