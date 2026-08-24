---
name: authz-setup
description: >
  Install and configure @adonis-agora/authz in an AdonisJS app. Covers
  `node ace configure @adonis-agora/authz` and its published files
  (config/authz.ts, app/abilities/authz.ts, RBAC migration), defineConfig with
  stores.lucid() / stores.memory(), autoCreateSchema vs owning the schema via
  createAuthzTables/dropAuthzTables with matching tables overrides, the
  resolveUserRef seam (defaultResolveUserRef, identityUserRef), the tenant
  resolver, and the ace commands authz:grant / authz:assign / authz:list /
  authz:sync with the idempotent catalog. Use when installing, wiring config,
  choosing between auto-created or migrated RBAC tables, seeding roles and
  permissions, or mapping a custom user model to a { type, id } UserRef.
metadata:
  type: core
  library: "@adonis-agora/authz"
  library_version: "0.10.5"
  framework: adonisjs
sources:
  - DavideCarvalho/adonis-authz:docs/getting-started.mdx
  - DavideCarvalho/adonis-authz:docs/config.mdx
  - DavideCarvalho/adonis-authz:docs/commands.mdx
  - DavideCarvalho/adonis-authz:packages/core/src/define_config.ts
  - DavideCarvalho/adonis-authz:packages/core/src/stores/lucid-schema.ts
---

# Setup: install, configure, seed

`node ace configure @adonis-agora/authz` registers the provider and commands,
and publishes `config/authz.ts`, `app/abilities/authz.ts` (the `can` /
`hasRole` Bouncer abilities), and a Lucid migration for the five RBAC tables
(`authz_roles`, `authz_permissions`, `authz_role_permission`,
`authz_user_role`, `authz_user_permission` — exported as `AUTHZ_TABLES`).

## Setup

```sh
npm i @adonis-agora/authz
node ace configure @adonis-agora/authz
```

The lucid store manages its own schema: with `autoCreateSchema` at its default
it creates the five tables on first use — no migration needed to start.

For production, own the schema through the published migration instead so DDL
ships with your deploy:

```ts title="config/authz.ts"
import { defineConfig, stores } from '@adonis-agora/authz'

export default defineConfig({
  default: 'lucid',
  stores: {
    memory: stores.memory(),
    lucid: stores.lucid({ autoCreateSchema: false }), // tables come from the migration
  },
})
```

```sh
node ace migration:run
```

Both paths emit identical DDL (`CREATE TABLE IF NOT EXISTS`), so switching
later is safe — the migration finds the tables already there and does nothing.

## Core patterns

### Seed roles and permissions from the CLI or a catalog

```sh
node ace authz:make-role editor
node ace authz:make-permission posts.edit   # dotted/wildcard names allowed
node ace authz:grant editor posts.edit      # permission → role (creates either by name)
node ace authz:assign editor 42 --type=user --tenant=acme
node ace authz:list                         # every role (with permissions) + permission
```

Or declare a catalog and sync it (idempotent — only missing rows are created):

```ts title="config/authz.ts"
defineConfig({
  // ...
  catalog: {
    permissions: ['system.manage'],
    roles: {
      editor: ['posts.*'],
      viewer: ['posts.view', 'comments.view'],
    },
  },
})
```

```sh
node ace authz:sync
```

Source: `docs/commands.mdx`

### Map your user shape to a `{ type, id }` reference

The store never owns a users table; every row keys on a polymorphic `UserRef`.
The default resolver reads `user.id` plus an optional `user.type`. Override it
for your model:

```ts title="config/authz.ts"
import { defineConfig, identityUserRef, stores } from '@adonis-agora/authz'

export default defineConfig({
  // ...
  resolveUserRef: identityUserRef, // authkit identity → { type: 'user', id }
})
```

`normalizeUserRef('42' | 42 | { id: 42 })` all yield `{ type: 'user', id: '42' }`
— ids are stringified, a missing type means `'user'`.

Source: `docs/concepts.mdx`, `docs/bouncer-integration.mdx`

### Resolve the active tenant once in config

Return a tenant id string for the current request; omit for single-tenant apps.
Explicit `scope` call args take precedence over this resolver.

```ts title="config/authz.ts"
import { HttpContext } from '@adonisjs/core/http'

defineConfig({
  // ...
  tenant: () => HttpContext.getOrFail().request.header('x-tenant'),
})
```

Source: `docs/config.mdx`

## Common mistakes

### HIGH Shipping the autoCreateSchema default to production

With the default, the store runs `CREATE TABLE IF NOT EXISTS` on **first use**
— schema creation happens on whichever request arrives first, not in a reviewed
deploy step.

Wrong:

```ts
stores: {
  lucid: stores.lucid(), // autoCreateSchema defaults ON
}
```

Correct:

```ts
stores: {
  lucid: stores.lucid({ autoCreateSchema: false }),
}
```

Mechanism: `autoCreateSchema: false` makes the store assume the tables exist;
you own them via the published migration or `createAuthzTables(db)` in one of
your own. Both paths emit the same DDL, so flipping later is safe.

Source: `docs/config.mdx` (Stores → Lucid), `docs/getting-started.mdx`

### MEDIUM Table-name overrides diverge between store and helpers

Overriding table names in only one of the two places makes the migration create
tables the store never reads (or the store read tables the migration never
created).

Wrong:

```ts
await createAuthzTables(db, { tables: { ...AUTHZ_TABLES, roles: 'rbac_roles' } })
// config still on defaults → mismatched names
```

Correct:

```ts
const tables = { ...AUTHZ_TABLES, roles: 'rbac_roles' };
// config/authz.ts → stores.lucid({ autoCreateSchema: false, tables })
await createAuthzTables(db, { tables }) // same override in both places
```

Mechanism: the standalone schema helpers accept `{ tables? }` precisely so they
can agree with the store's `tables` option; nothing cross-checks them.

Source: `docs/config.mdx` ("Standalone schema helpers")

### MEDIUM Expecting authz:sync to revoke removed grants

`authz:sync` is deliberately idempotent: it creates missing roles/permissions
and attaches missing links, but never deletes rows dropped from the catalog.

Wrong:

```sh
# removed posts.delete from catalog, ran sync, assumed revoked
node ace authz:sync
```

Correct:

```sh
node ace authz:list          # inspect what exists
# revoke explicitly via store.revokePermissionFromRole(...) first, then:
node ace authz:sync
```

Mechanism: sync's contract is additive-only ("only missing rows are
created/attached"), so stale grants survive every re-sync.

Source: `docs/commands.mdx`
