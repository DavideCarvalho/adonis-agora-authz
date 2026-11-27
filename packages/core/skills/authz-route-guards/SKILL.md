---
name: authz-route-guards
description: >
  Guard AdonisJS routes with @adonis-agora/authz: the named middleware
  requireRole (@adonis-agora/authz/middleware), any-of roles or permissions
  against effectiveRoles / effectivePermissions (wildcard-aware),
  RequireRoleOptions (roles, permissions, scope, guestRedirect,
  deniedRedirect, deniedMessage, onDenied), apps calling this one
  (ctx.agora.caller) as { type: 'app', id } and permitAuthz for the libs'
  app-caller seams. Use when keeping routes behind a role or permission,
  redirecting unauthenticated or unauthorized requests, letting the host
  decide the denial, or letting another app in. Also covers authorizeByRoles,
  the authorize hook for @adonis-agora dashboards, which returns an
  AuthorizeResult (true | { allowed: true, tenants: '*' } | { allowed: false, reason }).
metadata:
  type: core
  library: "@adonis-agora/authz"
  library_version: "1.0.0"
  framework: adonisjs
sources:
  - DavideCarvalho/adonis-authz:docs/middleware.mdx
  - DavideCarvalho/adonis-authz:packages/core/src/middleware.ts
  - DavideCarvalho/adonis-authz:packages/core/src/authorize.ts
  - DavideCarvalho/adonis-authz:packages/core/src/app_callers.ts
  - DavideCarvalho/adonis-authz:docs/agora-integration.mdx
---

# Route guards: requireRole

`AuthzRoleMiddleware` is the "require role X" guard every app otherwise
rewrites by hand. It gates on **effective** roles (global ∪ tenant ∪ app ∪ store), so a
token claim, a domain-table role, and a store assignment all satisfy the same
guard. It gates routes on **either** dimension: role names (`roles`) or
permissions with wildcards (`permissions`) — the coarse gate; per-record
decisions stay with Bouncer abilities and query scopes.

## Setup

```ts title="start/kernel.ts"
import router from '@adonisjs/core/services/router'

router.use([() => import('@adonisjs/auth/initialize_auth_middleware')])

export const middleware = router.named({
  requireRole: () => import('@adonis-agora/authz/middleware'),
})
```

The user comes from `ctx.auth.user` (any `@adonisjs/auth` guard, set by its
`initialize_auth_middleware`). The service arrives via
constructor injection (`@inject()`); no service locator in the flow.

## Core patterns

### Any-of roles per route

```ts title="start/routes.ts"
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const CoordinatorController = () => import('#controllers/coordinator_controller')
const ReportsController = () => import('#controllers/reports_controller')

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
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AdminController = () => import('#controllers/admin_controller')

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
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AdminController = () => import('#controllers/admin_controller')

router
  .get('/admin', [AdminController, 'dashboard'])
  .use(middleware.requireRole({ permissions: ['admin.*'] }))
```

Source: `docs/middleware.mdx`

### Call the engine directly when you need the union

```ts
import authz from '@adonis-agora/authz/services/main'
import type User from '#models/user'

export async function rolesOf(user: User) {
  const roles = await authz.effectiveRoles(user)                  // active tenant when context tenancy is on, else global scope
  const scoped = await authz.effectiveRoles(user, { tenantId: 'acme' })
  return { roles, scoped }
}
```

`effectiveRoles` populates the request's global roles along the way, so
`roles: ['ADMIN']` matches a token claim even with nothing seeded in the store.
Anonymous/unmappable users yield `[]`.

Source: `docs/middleware.mdx`, `docs/roles.mdx`

### Gate an @adonis-agora dashboard: authorizeByRoles

```ts title="config/telescope_ui.ts"
import { defineConfig } from '@adonis-agora/telescope/ui'
import { authorizeByRoles } from '@adonis-agora/authz'

export default defineConfig({
  authorize: authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' }),
})
```

Returns an `AuthorizeResult` (`boolean | AuthorizeDecision`, both exported):
`true` when the user holds one of `roles`; `{ allowed: false, reason:
'unauthenticated' }` with no session (dashboard answers `401`; with `loginPath`
a page navigation — `Accept: text/html` — is redirected to the login first);
`{ allowed: false, reason: 'forbidden' }` when signed in without the role (`403`,
never redirected — it would loop). With `allTenants` set, a viewer holding one
of those roles globally (or a `superAdminRoles` role) is allowed with
`{ allowed: true, tenants: '*' }` — every organization; a tenant-scoped role
never counts for `allTenants`.

Requires the dashboard lib versions that accept `AuthorizeDecision` (see the
version list in `docs/middleware.mdx`). The denial is an object, so it is
truthy: an older dashboard doing `if (!(await authorize(ctx)))` would let it
through. Older dashboards type the hook `(ctx) => boolean | Promise<boolean>`,
so the mismatch surfaces as a typecheck error — upgrade the dashboard, never
cast it away.

Source: `docs/middleware.mdx`, `packages/core/src/authorize.ts`

## Common mistakes

### MEDIUM Listing a permission in the `roles` option

`roles` matches **role names exactly**; permissions are a separate option. A
permission name in `roles` never matches, and the route denies a user who does
hold the permission — silently, because both are just strings.

Wrong:

```ts
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const PostsController = () => import('#controllers/posts_controller')

router.get('/posts', [PostsController, 'index'])
  .use(middleware.requireRole({ roles: ['posts.view'] })) // never matches a role
```

Correct:

```ts
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const PostsController = () => import('#controllers/posts_controller')

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

```ts no-check
await authz.store.assignRole({ type: 'user', id: '42' }, 'ADMIN'); // redundant
router.get('/admin', ...).use(middleware.requireRole({ roles: ['ADMIN'] }));
```

Correct:

```ts
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AdminController = () => import('#controllers/admin_controller')

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

```ts no-check
.use(middleware.requireRole({ roles: ['ADMIN'] })) // SSR app → JSON 401/403
```

Correct:

```ts no-check
.use(middleware.requireRole({
  roles: ['ADMIN'],
  guestRedirect: '/login',
  deniedRedirect: '/unauthorized',
}))
```

Mechanism: the defaults are `401 Unauthenticated` / `403 Forbidden` responses;
redirects are opt-in per route.

Source: `docs/middleware.mdx` (RequireRoleOptions table)

### MEDIUM Gating an app-only route on a user role

A request from another app (an authkit service token, `ctx.agora.caller`) has no
user: `requireRole` checks the app itself, so a user role it was never given
denies it (`403`).

Wrong:

```ts no-check
.use(middleware.requireRole({ roles: ['ADMIN'] })) // the calling app → 403
```

Correct:

```ts no-check
.use(middleware.requireRole({ permissions: ['reports:export'] }))
```

Mechanism: the caller is the subject `{ type: 'app', id }`;
it passes by its roles in authz or by `authz.can` on each permission: its token's
capabilities (Agora capability rule, `media:*`) and its grants in authz. For a
lib's seam (`authorizeAppCaller({ identify, permit })` in media) pass
`permit: permitAuthz()`.

Source: `docs/agora-integration.mdx` (Apps calling this app)
