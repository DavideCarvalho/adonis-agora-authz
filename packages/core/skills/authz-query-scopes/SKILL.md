---
name: authz-query-scopes
description: >
  Filter Lucid collections by authorization data with @adonis-agora/authz —
  accessibleBy(query, authz, user, resource) and applyScopeConstraint, the
  scopes config key with ScopeRegistry.register(Model | string, filter), the
  ScopeFilterContext fields (user, action, permissions, roles, tenant), the
  constraint DSL eq / where / whereIn / and / or / scopeAll / scopeNone with
  empty-group identities, the action option (default viewAny), and the
  resolution order (super-admin → wildcard grant → registered filter →
  deny-all). Use when listing only the rows a user may access, registering
  per-resource scope filters, reusing one resolved constraint across queries,
  or debugging a scope that returns zero rows.
metadata:
  type: core
  library: "@adonis-agora/authz"
  library_version: "0.10.5"
  framework: adonisjs
sources:
  - DavideCarvalho/adonis-authz:docs/query-scopes.mdx
  - DavideCarvalho/adonis-authz:docs/concepts.mdx
  - DavideCarvalho/adonis-authz:packages/core/src/lucid_scope.ts
  - DavideCarvalho/adonis-authz:packages/core/src/scope_kit.ts
---

# Query scopes: accessibleBy and the constraint DSL

`can` decides yes/no for one resource; a query scope filters a **collection**
to the rows a user may access, applied at the DB layer. `accessibleBy` is the
consumer; until you **register** a filter for a resource, that resource is
deny-all (fail-closed) and returns no rows for anyone.

## Setup

```ts title="config/authz.ts"
import { defineConfig, stores } from '@adonis-agora/authz'
import { and, eq, or } from '@adonis-agora/authz/scope'
import Post from '#models/post'
import Invoice from '#models/invoice'

export default defineConfig({
  default: 'lucid',
  stores: { lucid: stores.lucid({ autoCreateSchema: false }) },

  scopes: (registry) => {
    // owner OR published
    registry.register(Post, ({ user }) =>
      or(eq('author_id', user.id), eq('published', true)),
    )

    // managers see every invoice in their tenant; others only their own
    registry.register(Invoice, ({ user, roles, tenant }) => {
      if (roles.includes('manager')) return true // allow-all
      return and(
        eq('user_id', user.id),
        ...(tenant ? [eq('tenant_id', tenant.tenantId)] : []),
      )
    })
  },
})
```

```ts
import { accessibleBy } from '@adonis-agora/authz/scope'

const scoped = await accessibleBy(Post.query(), authz, user, Post)
const posts = await scoped // second await runs the query
```

## Core patterns

### The filter context and its return shapes

A filter receives the SAME authorization data `can` consults — no store
re-query — and may return a constraint, `true` (allow-all), or
`false`/`null`/`undefined` (deny-all). It may be async.

```ts
registry.register(Document, async ({ user, roles }) => {
  if (roles.includes('auditor')) return true // sees everything
  const teamIds = await TeamMember.query().where('user_id', user.id).select('team_id')
  return whereIn('team_id', teamIds.map((t) => t.teamId))
})
```

Context: `user` (resolved `{ type, id }`), `action` (default `'viewAny'`),
`permissions` (effective, wildcard-aware), `roles` (effective), `tenant`
(`TenantScope | undefined`).

Source: `docs/query-scopes.mdx`

### The DSL and empty-group identities

Builders produce a pure-data AST compiled into parameterized, identifier-safe
WHERE clauses. Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`,
`isNull`, `isNotNull`. `and()` with no nodes is allow-all; `or()` with no nodes
is deny-all — so you can spread conditionally without special cases.

```ts
import { and, eq, or, where, whereIn } from '@adonis-agora/authz/scope'

// (owner OR published) AND not archived
and(
  or(eq('author_id', user.id), eq('published', true)),
  where('status', 'ne', 'archived'),
)
```

Source: `docs/query-scopes.mdx`

### Scope by a specific action, then keep chaining

`action` defaults to `'viewAny'`; a wildcard grant covering it short-circuits
to allow-all before any filter runs.

```ts
const editable = await accessibleBy(Post.query(), authz, user, Post, {
  action: 'posts.edit',
})
const recent = await editable.orderBy('created_at', 'desc').limit(20)
```

Source: `docs/query-scopes.mdx`

### Split resolve from apply to cache or inspect the constraint

`authz.scope()` resolves the `ScopeConstraint` alone; `applyScopeConstraint`
compiles it onto any Lucid query, synchronously, returning the same builder.

```ts
import { applyScopeConstraint } from '@adonis-agora/authz/scope'
import authz from '@adonis-agora/authz/services/main'

const constraint = await authz.scope(user, Post)
if (constraint.kind === 'none') return { posts: [], count: 0 } // skip the query

const posts = await applyScopeConstraint(Post.query(), constraint).limit(20)
const [{ count }] = await applyScopeConstraint(Post.query(), constraint).count('* as count')
```

Source: `docs/query-scopes.mdx`, `docs/service.mdx`

## Common mistakes

### CRITICAL Applying the scope after a top-level orWhere

The scope is appended with `AND`, and in SQL `AND` binds tighter than `OR` —
gluing it onto a top-level `OR` constrains only the last branch, leaking rows
even past a deny-all (`1 = 0`). The helper cannot re-group clauses you added.

Wrong:

```ts
const bad = Post.query().where('id', 1).orWhere('id', 2);
const posts = await accessibleBy(bad, authz, user, Post);
// id = 1 OR (id = 2 AND scope) — branch 1 is unscoped
```

Correct:

```ts
const base = Post.query().where((q) => q.where('id', 1).orWhere('id', 2));
const posts = await accessibleBy(base, authz, user, Post);
// (id = 1 OR id = 2) AND (scope)
```

Mechanism: `accessibleBy` appends clauses to the builder you pass; only you can
control where the top-level ORs live. Apply the scope FIRST, or wrap caller-side
ORs in their own group.

Source: `docs/concepts.mdx` (query-scopes warn Callout), `docs/query-scopes.mdx`

### CRITICAL Reading deny-all emptiness as data

A resource with no registered scope resolves to deny-all: `accessibleBy`
returns zero rows for EVERYONE — indistinguishable from an empty table, with no
error anywhere.

Wrong:

```ts
const posts = await accessibleBy(Post.query(), authz, user, Post);
// [] for admins too → "the table is empty" is the wrong conclusion
```

Correct:

```ts
// register the filter in config/authz.ts first:
scopes: (registry) => {
  registry.register(Post, ({ user }) =>
    or(eq('author_id', user.id), eq('published', true)));
}
```

Mechanism: `AuthzService.scope` resolves an unregistered resource to
`scopeNone` (fail-closed, like an unknown permission), by design.

Source: `docs/query-scopes.mdx` (opening warn Callout)

### MEDIUM Awaiting accessibleBy once and using the result as rows

`accessibleBy` resolves the constraint and applies it to the builder you passed,
returning that builder — the first await is the resolution, the second runs the
query.

Wrong:

```ts
const posts = await accessibleBy(Post.query(), authz, user, Post);
console.log(posts.length); // undefined — still a query builder
```

Correct:

```ts
const scoped = await accessibleBy(Post.query(), authz, user, Post);
const posts = await scoped; // or scoped.exec()
```

Mechanism: the helper returns the query builder, not a promise of rows; only
the second await executes SQL.

Source: `docs/concepts.mdx` ("So there are two awaits"), `docs/query-scopes.mdx`
