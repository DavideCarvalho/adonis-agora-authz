---
name: authz-roles-tenancy
description: >
  Reconcile roles and tenants with @adonis-agora/authz as the single authority —
  the effective-role union (token claim ∪ resolveRoles seam ∪ store.assignRole),
  hasRole/hasAnyRole over that union, the reverse lookup usersWithRole and its
  reverse seams resolveRoleMembers / resolveGlobalRoleMembers, config-only
  roleGrants, superAdminRoles matched against global context roles only, tenant
  visibility rules (GLOBAL_TENANT '', normalizeTenant, tenant sees global ∪ own,
  direct grants tenant-independent), and the Agora bridges resolveTenant /
  tenantFromContext / globalRolesFromContext. Use when wiring multi-source
  roles, notifying everyone who holds a role, making checks tenant-aware, or
  deciding between superAdminRoles and a roleGrants wildcard.
metadata:
  type: core
  library: "@adonis-agora/authz"
  library_version: "0.10.5"
  framework: adonisjs
sources:
  - DavideCarvalho/adonis-authz:docs/roles.mdx
  - DavideCarvalho/adonis-authz:docs/concepts.mdx
  - DavideCarvalho/adonis-authz:docs/config.mdx
  - DavideCarvalho/adonis-authz:docs/agora-integration.mdx
  - DavideCarvalho/adonis-authz:packages/core/src/authz_service.ts
---

# Roles & tenancy: one union, one scope model

An app's roles live in three places at once — the token claim, domain tables,
the authz store. authz does not move them; it unions them and answers **every**
role question forwards (`effectiveRoles`) and backwards (`usersWithRole`) off
that one union. Nothing else in the app should ask a role source directly.

## Setup

```ts title="config/authz.ts"
import { defineConfig, stores } from '@adonis-agora/authz'
import UserRole from '#models/user_role'

export default defineConfig({
  default: 'lucid',
  stores: { lucid: stores.lucid({ autoCreateSchema: false }) },

  // Forward: app roles from YOUR tables enter the union.
  resolveRoles: async (user, scope) => {
    const rows = await UserRole.query()
      .where('user_id', user.id)
      .if(scope?.tenantId, (query) => query.where('tenant_id', scope!.tenantId!))
    return rows.map((row) => row.role)
  },
})
```

```ts
import authz from '@adonis-agora/authz/services/main'

await authz.effectiveRoles(user)                       // global ∪ app ∪ store
await authz.effectiveRoles(user, { tenantId: 'acme' }) // tenant-filtered
```

## Core patterns

### Reverse lookup: who holds this role?

`usersWithRole` mirrors `effectiveRoles` — store ∪ `resolveRoleMembers` ∪
`resolveGlobalRoleMembers`, run in parallel, deduped by `(type, id)`. It
returns `UserRef`s; hydrate with your own models.

```ts title="config/authz.ts"
defineConfig({
  // ...resolveRoles above...
  // Reverse of resolveRoles — read the SAME source.
  resolveRoleMembers: async (role, scope) => {
    const rows = await UserRole.query()
      .where('role', role)
      .if(scope?.tenantId, (query) => query.where('tenant_id', scope!.tenantId!))
    return rows.map((row) => row.userId)
  },
  // Reverse of the token's global-role claim.
  resolveGlobalRoleMembers: async (role) => {
    const accounts = await Account.query().whereJsonSuperset('global_roles', [role])
    return accounts.map((account) => ({ type: 'user', id: account.id }))
  },
})
```

```ts title="app/services/notify_coordinators.ts"
import authz from '@adonis-agora/authz/services/main'
import User from '#models/user'

export async function notifyCoordinators(tenantId: string, message: string) {
  const refs = await authz.usersWithRole('COORDINATOR', { tenantId })
  const ids = refs.filter((ref) => ref.type === 'user').map((ref) => ref.id)
  if (ids.length === 0) return
  const users = await User.query().whereIn('id', ids)
  await Promise.all(users.map((user) => user.notify(message)))
}
```

Source: `docs/roles.mdx`

### Config-only grants via roleGrants

Map effective roles onto permissions/wildcards without seeding the store; the
mapping applies to roles from any of the three sources.

```ts title="config/authz.ts"
defineConfig({
  roleGrants: {
    editor: ['posts.*', 'comments.moderate'],
    auditor: ['audit.*'],
  },
})
```

Source: `docs/config.mdx`, `docs/agora-integration.mdx`

### Tenant auto-scope from the request or context

Precedence: explicit `scope` arg → `tenant` resolver → opt-in `resolveTenant`.
With none of them yielding a value, the check runs in the global `''` scope.

```ts title="config/authz.ts"
import { defineConfig, stores, tenantFromContext } from '@adonis-agora/authz'
import { HttpContext } from '@adonisjs/core/http'

defineConfig({
  // ...
  resolveTenant: tenantFromContext,          // Agora context, or any () => string | undefined
  tenant: () => HttpContext.getOrFail().request.header('x-tenant'),
})
```

Source: `docs/agora-integration.mdx`, `docs/config.mdx`

### Spell "no tenant" the same way on both sides

The global scope is the empty string; `normalizeTenant` collapses any
`TenantScope` (including `undefined`) down to it.

```ts
import { GLOBAL_TENANT, normalizeTenant } from '@adonis-agora/authz'

normalizeTenant({ tenantId: 'acme' }) // 'acme'
normalizeTenant(undefined)            // '' — GLOBAL_TENANT
```

Source: `docs/concepts.mdx`

## Common mistakes

### CRITICAL Checking roles through the auth provider

An identity-provider role query sees only the token claim. The same role
assigned in the store or returned by `resolveRoles` is invisible there, so the
answer disagrees with `bouncer.allows('hasRole', ...)` for the identical user.

Wrong:

```ts
if (await identity.hasGlobalRole('admin')) { /* admin-only path */ }
```

Correct:

```ts
import authz from '@adonis-agora/authz/services/main';

if (await authz.hasRole(user, 'admin')) { /* admin-only path */ }
```

Mechanism: `hasRole` tests the full effective union (context ∪ app ∪ store);
provider-side checks test one source of three.

Source: `docs/bouncer-integration.mdx` ("Division of responsibility" warn Callout)

### HIGH Wiring resolveRoles without its reverse seam

`usersWithRole` answers only from configured sources. An unwired
`resolveRoleMembers` contributes nothing **silently** — a shorter list, not an
error — so users whose roles come from your domain tables are missed everywhere
the reverse lookup is used.

Wrong:

```ts
defineConfig({
  resolveRoles: async (user, scope) => { /* reads user_roles */ },
  // resolveRoleMembers missing → those users never come back
})
```

Correct:

```ts
defineConfig({
  resolveRoles: async (user, scope) => { /* reads user_roles */ },
  resolveRoleMembers: async (role, scope) => { /* reads the SAME table */ },
})
```

Mechanism: the forward union reads three sources by design; the reverse union
can only walk sources you wire, and absence is indistinguishable from "nobody".

Source: `docs/roles.mdx` ("The reverse seams" warn Callout)

### HIGH Assigning superAdminRoles outside the global context

`superAdminRoles` matches only the token's global context roles. The same name
assigned in the store or returned by `resolveRoles` becomes an ordinary role —
it satisfies `hasRole('platform:super')` and picks up `roleGrants`, but skips
no checks.

Wrong:

```ts
defineConfig({ superAdminRoles: ['platform:super'] });
// elsewhere: hoping the store assignment grants the bypass
await authz.store.assignRole(ref, 'platform:super');
```

Correct:

```ts
// keep the bypass in the IdP claim — or use an auditable wildcard grant instead:
defineConfig({
  superAdminRoles: ['platform:super'],
  roleGrants: { auditor: ['audit.*'] },
});
```

Mechanism: the bypass is deliberately matched against global roles only, so no
store write can mint a super-admin.

Source: `docs/roles.mdx` (superAdminRoles section), `docs/config.mdx`

### MEDIUM Expecting direct permission grants to be tenant-scoped

Direct user-permission grants are tenant-**independent**: they apply in every
scope, including global requests that see no tenant rows. Only role assignments
carry a tenant.

Wrong:

```ts
// assuming a scoped variant exists
await authz.store.giveUserPermission(ref, 'billing.view', { tenantId: 'acme' } as never);
```

Correct:

```ts
// grants are global by design — put tenancy on a ROLE assignment instead:
await authz.store.giveUserPermission(ref, 'billing.view'); // applies everywhere
await authz.store.assignRole(ref, 'billing', { tenantId: 'acme' }); // scoped
```

Mechanism: the visibility contract fixes direct grants outside the tenant model
(invariant #3 of the store contract), so scoping must be modeled through roles.

Source: `docs/concepts.mdx` (Multi-tenancy), `docs/testing.mdx`
