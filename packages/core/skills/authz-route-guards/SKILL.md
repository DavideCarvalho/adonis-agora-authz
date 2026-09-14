---
name: authz-route-guards
description: >
  Guard AdonisJS routes with @adonis-agora/authz — AuthzRoleMiddleware
  registered as the named middleware requireRole from the
  @adonis-agora/authz/middleware subpath, any-of roles or permissions matching
  against AuthzService.effectiveRoles (global token claim ∪ resolveRoles ∪
  store) and effectivePermissions (wildcard-aware), RequireRoleOptions (roles,
  permissions, scope, guestRedirect, deniedRedirect, deniedMessage, onDenied),
  and where per-record checks belong instead (Bouncer can in the action,
  accessibleBy for collections). Use when keeping route trees behind a role or
  a permission, redirecting unauthenticated or unauthorized requests in SSR /
  Inertia apps, letting the host decide the denial response, or wiring
  start/kernel.ts middleware.
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
guard. It gates routes on **either** dimension: role names (`roles`) or
permissions with wildcards (`permissions`) — the coarse gate; per-record
decisions stay with Bouncer abilities and query scopes.

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

Options: `roles` / `permissions` (at least one must be non-empty), `scope`
(`TenantScope` forwarded to `effectiveRoles`/`effectivePermissions`),
`guestRedirect`, `deniedRedirect`, `deniedMessage` (default `'Forbidden'`),
`onDenied(ctx, { roles, permissions })` — the host decides the denial response
(flash + redirect per area, custom 403); it overrides `deniedRedirect`/
`deniedMessage` and must respond.

Source: `docs/middleware.mdx`

### Open a route by permission (wildcards either side)

A route listed `permissions: ['admin.*']` admits anyone holding ANY `admin.*`
permission — roles created at runtime included. The wildcard may sit on the
grant (`admin.*` opens route `admin.users`) or on the route (route `admin.*`
opens for a grant of `admin.users`). Permissions are only read when `roles`
did not match — a role pass costs no permission query.

```ts
router
  .get('/admin', [AdminController, 'dashboard'])
  .use(middleware.requireRole({ permissions: ['admin.*'] }))
```

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

### MEDIUM Listing a permission in the `roles` option

`roles` matches **role names exactly**; permissions are a separate option. A
permission name in `roles` never matches, and the route denies a user who does
hold the permission — silently, because both are just strings.

Wrong:

```ts
router.get('/posts', [PostsController, 'index'])
  .use(middleware.requireRole({ roles: ['posts.view'] })) // never matches a role
```

Correct:

```ts
router.get('/posts', [PostsController, 'index'])
  .use(middleware.requireRole({ permissions: ['posts.view'] }))
// and when the user is an EDITOR by role:
//   .use(middleware.requireRole({ roles: ['EDITOR'] }))
```

Mechanism: route-level permission checks go through `effectivePermissions`
(the wildcard-aware `permissions` option); action-level, resource-specific
decisions still belong in a Bouncer ability or a query scope, which can see
the record being acted on. The `roles` gate and the `permissions` gate are both
coarse; the division of labor is *coarse vs. per-record*, not role vs. permission.

Source: `docs/middleware.mdx`, `docs/bouncer-integration.mdx`

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
