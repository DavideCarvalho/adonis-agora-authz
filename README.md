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

See the [docs](./docs) for concepts (wildcards, tenancy), config drivers, the
Lucid mixin, ace commands and testing.

## License

MIT
