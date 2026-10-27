# `@adonis-agora/authz`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/authz)](https://www.npmjs.com/package/@adonis-agora/authz) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/authz)](https://www.npmjs.com/package/@adonis-agora/authz) [![CI](https://github.com/DavideCarvalho/adonis-agora-authz/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-authz/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/authz)](https://www.npmjs.com/package/@adonis-agora/authz)

> Bouncer-integrated, DB-backed **RBAC** for **AdonisJS** — roles, permissions,
> wildcard matching and multi-tenancy on top of
> [`@adonisjs/bouncer`](https://docs.adonisjs.com/guides/security/authorization),
> with pluggable stores. Part of the
> [Agora](https://github.com/DavideCarvalho) ecosystem.

It does **not** replace Bouncer — it registers a small set of static Bouncer
abilities (`can`, `hasRole`) whose body consults a database-backed permission
store. You keep using `ctx.bouncer.allows(...)` and `@can(...)` exactly as you
do today.

## Install

```sh
npm i @adonis-agora/authz
node ace configure @adonis-agora/authz
node ace migration:run   # if you use the Lucid store
```

## Use

```ts
// app/abilities/authz.ts was published for you:
import { can, hasRole } from '#abilities/authz'

// In a controller / route:
await ctx.bouncer.allows('can', 'posts.edit', post)   // wildcard: posts.* ⊇ posts.edit
await ctx.bouncer.authorize('hasRole', 'admin')
```

```edge
@can('can', 'posts.edit')
  <a href="/posts/{{ post.id }}/edit">Edit</a>
@end
```

Grant from the CLI or programmatically:

```sh
node ace authz:grant editor posts.edit
node ace authz:assign editor 42
```

Need resource-aware allow **and deny** from an external policy engine? Plug a
`decisionProvider` into `config/authz.ts` — a Cerbos adapter ships at
`@adonis-agora/authz/cerbos` (no extra runtime dependency; bring your own
`@cerbos/http` client). It runs right after the super-admin check, batches
`authz.canMany`, and maps Cerbos query plans onto `accessibleBy` scopes.

See the [docs](./docs) for concepts (wildcards, tenancy), config drivers, the
Lucid mixin, ace commands and testing.

## Dashboards

`authorizeByRoles({ roles: ['ADMIN'] })` is the `authorize` hook for the
`@adonis-agora` dashboards (telescope, durable, media, payments, agent). It
returns an `AuthorizeResult`: `true`, or `{ allowed: false, reason:
'unauthenticated' | 'forbidden' }` so the dashboard can answer `401` vs `403`.

> **Requires the dashboard lib versions that accept `AuthorizeDecision`.** The
> denial is an object (truthy); an older dashboard that treats the result as a
> boolean would let it through. See the minimum versions in
> [`docs/middleware.mdx`](../../docs/middleware.mdx#authorizebyroles--the-same-gate-for-dashboards).

## License

MIT
