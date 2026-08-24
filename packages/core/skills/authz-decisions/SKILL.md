---
name: authz-decisions
description: >
  Answer may-I questions with @adonis-agora/authz — the Bouncer abilities can
  and hasRole published to #abilities/authz via defineAuthzAbilities /
  authzAbilities, ctx.bouncer.allows/authorize/denies and Edge @can, the
  AuthzService decision surface (can, hasRole, hasAnyRole,
  effectivePermissions) from the services/main singleton or the container
  class, wildcard matching with permissionSatisfied / permissionMatches over
  granted patterns like posts.*, the superAdmin hook + superAdminRoles
  short-circuit, and the per-request PermissionCache from createCache(). Use
  when checking a permission or role in controllers, jobs, ace commands or
  Edge templates; when wiring Bouncer abilities; when tuning the super-admin
  hook; or when many checks per request need one grant read.
metadata:
  type: core
  library: "@adonis-agora/authz"
  library_version: "0.10.5"
  framework: adonisjs
sources:
  - DavideCarvalho/adonis-authz:docs/bouncer-integration.mdx
  - DavideCarvalho/adonis-authz:docs/service.mdx
  - DavideCarvalho/adonis-authz:docs/concepts.mdx
  - DavideCarvalho/adonis-authz:packages/core/src/authz_service.ts
  - DavideCarvalho/adonis-authz:packages/core/src/permission_matcher.ts
---

# Decisions: can, hasRole, wildcards, super-admin, cache

Bouncer has no runtime API to register one ability per DB row, so authz
registers two **static** abilities whose bodies consult the DB-backed store:
`can(user, permission, resource?)` (wildcard-aware) and `hasRole(user, role)`.
Both deny anonymous users. Everything else — jobs, commands, scheduled tasks —
calls `AuthzService` directly.

## Setup

```ts title="app/abilities/authz.ts"
import app from '@adonisjs/core/services/app'
import { AuthzService, defineAuthzAbilities } from '@adonis-agora/authz'

const service = await app.container.make(AuthzService)

export const { can, hasRole } = defineAuthzAbilities(service)
```

```ts title="start/routes.ts (or a controller)"
import { can, hasRole } from '#abilities/authz'

router.put('/posts/:id', async (ctx) => {
  const post = await Post.findOrFail(ctx.params.id)

  // boolean check — no throw (wildcards apply: posts.* ⊇ posts.edit)
  if (await ctx.bouncer.allows('can', 'posts.edit', post)) { /* ... */ }

  // throwing check — E_AUTHORIZATION_FAILURE → HTTP 403 on deny
  await ctx.bouncer.authorize('hasRole', 'admin')
})
```

```edge
@can('can', 'posts.edit')
  <a href="/posts/{{ post.id }}/edit">Edit</a>
@end
```

## Core patterns

### Call the engine directly outside HTTP

The singleton exposes only the async decision surface and is safe at
config-load time. Writes, `store`, `scopes`, and `createCache()` need the class
from the container — both forms are the same instance.

```ts title="app/jobs/publish_post.ts"
import authz from '@adonis-agora/authz/services/main'

export default class PublishPost {
  async handle(user: User) {
    if (!(await authz.can(user, 'posts.publish'))) {
      throw new Error('not allowed to publish')
    }
  }
}
```

```ts
import { AuthzService } from '@adonis-agora/authz'
import app from '@adonisjs/core/services/app'

const service = await app.container.make(AuthzService)
const cache = service.createCache() // sync members live on the class
```

Source: `docs/service.mdx`

### Ship the permission set with `effectivePermissions`

`can()` answers one question; the full set is what you want for UI snapshots,
audit logs, or debugging endpoints. It contains granted **patterns** —
`posts.*` stays `posts.*`.

```ts
import authz from '@adonis-agora/authz/services/main'
import { permissionSatisfied } from '@adonis-agora/authz'

const permissions = await authz.effectivePermissions(user)
permissionSatisfied(permissions, 'posts.edit') // wildcard-aware membership test
```

Source: `docs/service.mdx`

### Tune the super-admin short-circuit

Every decision (`can`, `hasRole`, `hasAnyRole`, `scope`) consults the hook
first, then `superAdminRoles`. The hook's second argument names the thing being
checked: `'posts.edit'` for `can`, the action for `scope`, `'role:admin'` for
`hasRole`, `'role:a,b'` for `hasAnyRole`.

```ts title="config/authz.ts"
defineConfig({
  superAdmin: (user, ability) => {
    if (user.type === 'service' && ability.startsWith('jobs.')) return true
    if (user.id === BANNED_ID) return false // hard deny — overrides every grant
    return undefined                        // otherwise: normal RBAC
  },
  superAdminRoles: ['platform:super'], // global context roles only
})
```

Source: `docs/service.mdx`, `docs/config.mdx`

### Coalesce reads with a per-request PermissionCache

One cache per request collapses N checks into one store read per
`(user, tenant)` — including concurrent ones.

```ts title="app/controllers/posts_controller.ts"
export default class PostsController {
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make(AuthzService)
    const cache = service.createCache()

    return {
      canCreate: await service.can(ctx.auth.user, 'posts.create', { cache }),
      canModerate: await service.can(ctx.auth.user, 'comments.moderate', { cache }),
    }
  }
}
```

Source: `docs/service.mdx`

## Common mistakes

### CRITICAL Testing wildcard grants with Array.includes

`effectivePermissions` returns granted patterns verbatim; exact-match inclusion
rejects every wildcard grant even though the server would allow the check.

Wrong:

```ts
const perms = await authz.effectivePermissions(user);
if (!perms.includes('posts.edit')) throw new ForbiddenException();
```

Correct:

```ts
import { permissionSatisfied } from '@adonis-agora/authz';

const perms = await authz.effectivePermissions(user);
if (!permissionSatisfied(perms, 'posts.edit')) throw new ForbiddenException();
```

Mechanism: wildcard expansion happens in the service, not the database — the
store returns `posts.*` as-is, so only the segment matcher can satisfy
`posts.edit` from it.

Source: `docs/service.mdx` (Callout), `docs/concepts.mdx` (Wildcard matching)

### HIGH Expecting the can ability to inspect the resource argument

RBAC grants are model-less: the default `can` ability accepts `resource` for
ergonomic call sites and does not look at it, so "ownership" checks silently
decide on grants alone.

Wrong:

```ts
// looks like an ownership check — is not
await ctx.bouncer.authorize('can', 'posts.edit', post)
```

Correct:

```ts
await ctx.bouncer.authorize('can', 'posts.edit');   // RBAC layer
await ctx.bouncer.authorize('edit', post);          // your own policy owns records
```

Mechanism: model-less grants cannot express per-record ownership; pairing with a
regular Bouncer policy is the documented pattern.

Source: `docs/bouncer-integration.mdx` (Callout), `docs/getting-started.mdx` (Callout)

### HIGH Hoisting the PermissionCache to module scope

A cache is a snapshot that never expires and never invalidates; a module-level
one serves its warm grant set to every later caller, including after revocation.

Wrong:

```ts
// module scope — shared across requests, never invalidated
export const cache = (await app.container.make(AuthzService)).createCache();
```

Correct:

```ts
export async function check(user: unknown, perm: string) {
  const service = await app.container.make(AuthzService);
  return service.can(user, perm, { cache: service.createCache() });
}
```

Mechanism: `createCache()` memoizes `store.getPermissionsForUser` per
`(user, tenant)` forever by design — correct inside one request, wrong across
requests. Context roles and `resolveRoles` stay live because they bypass the
cache.

Source: `docs/service.mdx` ("per-request permission cache")

### MEDIUM Treating the superAdmin hook false as fall-through

The super-admin hook is the only hook whose `false` actively denies — it
short-circuits before grants are read and outranks `superAdminRoles`. Only
nullish falls through to RBAC.

Wrong:

```ts
superAdmin: (user) => {
  if (isBlocked(user)) return undefined; // meant "not super", actually "fall through"
},
```

Correct:

```ts
superAdmin: (user) => {
  if (isBlocked(user)) return false; // hard deny wins over any grant
  return undefined;
},
```

Mechanism: the resolution order treats `false` as a verdict, not an abstention;
blocked users keep access if they hold a matching grant.

Source: `docs/config.mdx` (superAdmin warn Callout), `docs/service.mdx`
