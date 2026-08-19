# @adonis-agora/authz

## 0.10.4

### Patch Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-authz/pull/36) [`4a9605d`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/4a9605de6abeb1b9d96bceaa8d5f8701f5d8f31f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the published migration stub, whose `up()` did not compile in a consumer
  app. `createAuthzTables` accepts a structural `LucidDatabase` whose `rawQuery`
  declared `bindings?: readonly unknown[]` — not assignable in either direction to
  Lucid's `RawQueryBindings`, since `readonly unknown[]` cannot go into the
  mutable `StrictValues[]` and the named-map branch is not an array. No real query
  client satisfied the interface, so `this.defer((db) => createAuthzTables(db))`
  was a type error for anyone who ran the migration.

  The mirrored binding type is now `readonly unknown[] | Record<string, unknown>`,
  which Lucid's own union fits into, and it is exported as `LucidQueryBindings`.

- [#36](https://github.com/DavideCarvalho/adonis-agora-authz/pull/36) [`4a9605d`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/4a9605de6abeb1b9d96bceaa8d5f8701f5d8f31f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `node ace configure @adonis-agora/authz`, which failed on every published
  version. Adonis renders a stub body through Tempura, which compiles it into a
  JavaScript template literal, so a backtick in the body terminates that literal
  early. All three stubs carried backticks in their doc comments, so `configure`
  threw `Unexpected identifier 'memory'` before writing a single file. The doc
  comments now use quotes; the `{{{ … }}}` header, which is evaluated as
  JavaScript, is unaffected.

## 0.10.3

### Patch Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-authz/pull/34) [`b55a532`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/b55a5324fd9126b2700f763d75af55b505c15c90) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the `@adonis-agora/diagnostics` peer range, which was unsatisfiable by every
  published version of that package. Under semver a caret does not cross a minor
  below 1.0, so `^0.1.0` meant `>=0.1.0 <0.2.0` while diagnostics had moved on to
  0.2.6. pnpm degrades an unsatisfied peer to a warning, but npm treats it as
  `ERESOLVE` and refuses to install — even though the peer is optional — so any
  app depending on both packages could not install under npm.

  The range is now `>=0.1.0 <1.0.0`. The floor is the earliest published version
  carrying the `onDiagnostic` subscriber authz actually calls, which is 0.1.0:
  that entry point is byte-identical across every release from 0.1.0 to 0.2.6.

## 0.10.2

### Patch Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-authz/pull/32) [`bd9ce3e`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/bd9ce3e66e8abef73216e26d73cc3af994289a86) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `engines.node`, which was published as the exact version `v26.7.0` instead
  of a supported range. Every consumer on any other Node version got an engine
  warning on install, and installs under `engine-strict` failed outright. The
  field is back to `>=20.6.0`, and Renovate no longer treats it as a pinnable
  dependency.

- [#32](https://github.com/DavideCarvalho/adonis-agora-authz/pull/32) [`bd9ce3e`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/bd9ce3e66e8abef73216e26d73cc3af994289a86) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the `accessibleBy` JSDoc example: it called `.exec()` on the returned
  Promise. `accessibleBy` resolves to the query builder, so the rows come from
  awaiting (or `.exec()`-ing) the builder the Promise resolves to.

## 0.10.1

### Patch Changes

- [`da44f77`](https://github.com/DavideCarvalho/adonis-authz/commit/da44f77ea620f3dc029a35cdfe5f8e285a8ecf13) - Fix: the reverse-lookup seams `resolveRoleMembers` and `resolveGlobalRoleMembers` (added in 0.10.0) are now reachable through `defineConfig`. They were declared on `AuthzServiceOptions` but missing from the `AuthzConfig` type and not forwarded by `AuthzProvider`, so `authz.usersWithRole` ignored them when configured via `config/authz.ts`. Added to `AuthzConfig` and wired through the provider (mirroring `resolveRoles`), with a provider-level plumbing test.

## 0.10.0

### Minor Changes

- [`ad2dff0`](https://github.com/DavideCarvalho/adonis-authz/commit/ad2dff0bb7a12943e47ae05d72604ec754523589) - Add the reverse effective-role lookup `authz.usersWithRole(role, scope?)` — the symmetric counterpart of `effectiveRoles`. It unions three sources in parallel: the authz store (new `PermissionStore.getUsersForRole(role, scope?)`, implemented for the Lucid and Memory stores with the same tenant-visibility rule as `getRolesForUser`), the domain reverse seam `resolveRoleMembers`, and the global/IdP reverse seam `resolveGlobalRoleMembers`. Bare-string ids are normalized to the default user type, `UserRefInput` objects via the existing normalizer, and results are deduped by `(type, id)`. Also surfaced on the `@adonis-agora/authz/services/main` singleton.

## 0.9.1

### Patch Changes

- [`b11ea9d`](https://github.com/DavideCarvalho/adonis-authz/commit/b11ea9dee21d9673f285cffbf0d40f95911efeb8) - Make the `@adonis-agora/authz/services/main` service singleton resolve the app from the instance `AuthzProvider` captures at registration, instead of `import app from '@adonisjs/core/services/app'`. In a pnpm workspace/hoisted install the package can resolve a different physical copy of `@adonisjs/core` than the one `bin/server` booted, whose `services/app` binding is never set — so the imported `app` was `undefined` and every call threw. The provider-captured instance is always the booted one, immune to core copy / peer-variant splits.

## 0.9.0

### Minor Changes

- [`afe5d3b`](https://github.com/DavideCarvalho/adonis-authz/commit/afe5d3b2fe0fbfed65f2645d120be16c307c6afe) - Add a service singleton export `@adonis-agora/authz/services/main` — a lazy, container-backed `AuthzService`. It resolves the container-bound service once, on first method call (not a top-level `await`), so it is safe to import from `config/*` without deadlocking boot. Use it wherever a resolved `AuthzService` is needed without hand-rolling `await app.container.make(AuthzService)`, including wiring the agent tool authorizer:

  ```ts
  import authz from "@adonis-agora/authz/services/main";
  import { authzToolAuthorizer } from "@adonis-agora/agent/authz";

  export default defineConfig({
    authorizer: authzToolAuthorizer({ authz }),
  });
  ```

  It forwards the async authorization-query surface (`can`, `scope`, `hasRole`, `hasAnyRole`, `effectiveRoles`, `effectivePermissions`).

## 0.8.1

### Patch Changes

- [`e1870da`](https://github.com/DavideCarvalho/adonis-authz/commit/e1870da64b20f04155ed5fb9127273cfbd88b878) - Fix the Lucid store crashing `AuthzService` construction with "Cannot read properties of undefined (reading 'booted')".

  `stores.lucid()` resolved the database via `import('@adonisjs/lucid/services/db')`, whose module-level `app` can be `undefined` when the `AuthzService` singleton is built during boot (the service default is only assigned inside `app.booted(...)`, and a dynamic import from this package may resolve a different module copy). When it threw, `app.container.make(AuthzService)` threw too, taking down every consumer — notably the agent's `authzToolAuthorizer`, which is fail-closed and therefore denied ALL tools, leaving the model with none. The store now resolves the db via `ctx.app.container.make('lucid.db')` (the same binding `services/db` uses, registered in the database provider's `register()`), so it builds correctly at boot.

## 0.8.0

### Minor Changes

- [#13](https://github.com/DavideCarvalho/adonis-authz/pull/13) [`e2cb451`](https://github.com/DavideCarvalho/adonis-authz/commit/e2cb45176db474b40b51bedf85277074f95b77a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `AuthzRoleMiddleware` agora recebe o `AuthzService` por injeção de construtor (`@inject()`) em vez de
  resolver pelo container no meio do `handle` (service locator). O container do Adonis instancia o
  middleware por request e injeta o serviço — DI idiomática, sem `container.make` no fluxo.

  O build passou a emitir `emitDecoratorMetadata`, necessário para o container ler os tipos do
  construtor. Consumidores que registram o middleware como named middleware
  (`() => import('@adonis-agora/authz/middleware')`) não precisam mudar nada.

## 0.7.0

### Minor Changes

- [#11](https://github.com/DavideCarvalho/adonis-authz/pull/11) [`c9d2d0f`](https://github.com/DavideCarvalho/adonis-authz/commit/c9d2d0f4025a3b9063ad9fadaaed071a6f9cebdc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novo middleware de rota `AuthzRoleMiddleware` (subpath `@adonis-agora/authz/middleware`) — exige um dos `roles` via `AuthzService.effectiveRoles` (global ∪ app ∪ store), cobrindo papéis globais (claim do token) e de app (DB) num só lugar. Substitui os middlewares "exige role X" que cada app reescreve por papel.

  ```ts
  // start/kernel.ts
  export const middleware = router.named({
    requireRole: () => import('@adonis-agora/authz/middleware'),
  })
  // rotas
  router.get('/coord', ...).use(middleware.requireRole({ roles: ['COORDINATOR'] }))
  router.get('/admin', ...).use(middleware.requireRole({ roles: ['ADMIN'], deniedRedirect: '/unauthorized' }))
  ```

  Opções: `roles` (any-of), `scope`, `guestRedirect` (senão 401), `deniedRedirect`/`deniedMessage` (senão 403). Lê o usuário de `ctx.auth.getUser()` (authkit) ou `ctx.auth.user` — estrutural, sem depender do authkit. Resolve o `AuthzService` lazy do container (sem `@inject`/reflect-metadata).

## 0.6.0

### Minor Changes

- [#9](https://github.com/DavideCarvalho/adonis-authz/pull/9) [`50ec77f`](https://github.com/DavideCarvalho/adonis-authz/commit/50ec77f0b81a7deeec089e286b877bcfb20148d2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the `resolveRoles` seam: `AuthzConfig`/`AuthzServiceOptions` gain `resolveRoles?: (user, scope?) => string[] | Promise<string[]>` for the app's own role source (e.g. a `user_roles` table), unioned into `can()`, `hasRole()` and `scope()` alongside the context (token) roles and the store's roles. New public `effectiveRoles()`/`effectivePermissions()` expose that same union so `@adonis-agora/authz-react`'s `buildAuthzShare` can match server decisions.

  **Breaking (0.x minor):** `globalRoleGrants` is renamed to `roleGrants` (no alias) on both `AuthzConfig` and `AuthzServiceOptions`, since it now applies to all effective roles (context + resolver), not just global/context ones. `hasRole()` now also recognizes context and `resolveRoles` roles, not just store-assigned ones (`hasAnyRole()` is unchanged — store-only).

## 0.5.0

### Minor Changes

- [#7](https://github.com/DavideCarvalho/adonis-authz/pull/7) [`8170e12`](https://github.com/DavideCarvalho/adonis-authz/commit/8170e12e731b57bed4195f0837cded57fa8c66b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Export standalone Lucid schema helpers `createAuthzTables`, `dropAuthzTables`, and
  `AUTHZ_TABLES`, so an app can create the RBAC tables from a Lucid migration instead of
  relying on `autoCreateSchema`. This mirrors `@adonis-agora/durable`'s `createDurableTables`
  and completes the ecosystem convention: a lib auto-manages its own tables by default
  (`autoCreateSchema`, still the default), lets you disable that, and exposes the DDL as a
  function you import into your own migration — the same code the store runs, so the two paths
  can never drift.

  Internals: the store's `ensureSchema` now delegates to `createAuthzTables`, and dialect
  detection also reads a directly-exposed `dialect` (a deferred migration query client), not
  only `connection().dialect`, so the migration path emits `TIMESTAMP` correctly on Postgres.
  The `configure` migration stub now delegates to these helpers. No breaking changes.

## 0.4.3

### Patch Changes

- [`bf741c1`](https://github.com/DavideCarvalho/adonis-authz/commit/bf741c1af40f10613d66f9c59358432ca2976e10) - Corrige a leitura das global roles do contexto: `globalRoleGrants` e o super-admin por role
  global voltam a funcionar.

  O bridge lia `accessor.get('globalRoles')`, mas o accessor do `@adonis-agora/context` implementava
  só `get()` (o store inteiro) — a chave era ignorada e vinha o store, o `Array.isArray` falhava, e
  `globalRolesFromContext()` devolvia `[]`. Resultado: toda permissão concedida por global role
  negava, em silêncio. Agora o bridge lê `get()` e indexa a chave localmente, o que funciona com
  qualquer versão do context (a forma sem argumento sempre existiu).

  Os testes do bridge falseavam `get(key) => valor` e `get() => valor-desembrulhado` — dois contratos
  que o context nunca shippou. Reescritos para a forma real (`get() => store`), que é o que deixava o
  bug invisível.

## 0.4.2

### Patch Changes

- [`0354acc`](https://github.com/DavideCarvalho/adonis-authz/commit/0354acc724ffcc5e0e1767247dfd42b2e78863e4) - fix: sync VERSION literal via sync-version guard

## 0.4.1

### Patch Changes

- [`c0c6a38`](https://github.com/DavideCarvalho/adonis-authz/commit/c0c6a38823a278d66f0731e0320e919dc2620d3e) - Harden the Lucid query-scope adapter (`accessibleBy` / `applyScopeConstraint`) against an `AND`/`OR` precedence trap and tighten identifier validation.

  - **Contract clarified (docs + JSDoc):** the query passed to `accessibleBy`/`applyScopeConstraint` MUST NOT have a top-level `orWhere`. Because SQL `AND` binds tighter than `OR`, an appended `AND (scope)` — including a deny-all `1 = 0` — only constrains the last `OR` branch and can leak rows. Knex cannot re-group clauses the caller already added, so the previous "compose freely with other clauses" claim was removed and replaced with the safe patterns: apply the scope first (then add only ANDed filters), or wrap any caller-side OR in its own `.where((q) => q.orWhere(…))` group.
  - **Defensive grouping:** the deny-all predicate is now emitted inside its own `where((sub) => sub.whereRaw('1 = 0'))` group, matching the already-grouped AST path, so the scope's own clauses are always a single self-consistent `AND`-group.
  - **Tighter identifier guard:** `SAFE_IDENTIFIER` now requires a real, non-empty segment on each side of every dot, so malformed-but-not-injectable identifiers like `a.`, `.a`, and `a..b` are rejected with a clear thrown error instead of producing broken SQL. Existing valid identifiers (`id`, `author_id`, `posts.author_id`) are unchanged.

## 0.4.0

### Minor Changes

- [`a30bb78`](https://github.com/DavideCarvalho/adonis-authz/commit/a30bb78cc610be7613ba62e21dd7bf6592d2b179) - feat: query-scope DSL for Lucid (accessibleBy) — constrain queries to rows a user may access

  Adds an optional, additive query-scope layer that filters a Lucid collection to the rows a user may access for a given action/resource — the `accessibleBy` / Pundit `policy_scope` / Cerbos query-plan concept — applied at the DB layer instead of over-fetch-then-filter. Existing `can`/`hasRole`/`hasAnyRole` behavior is unchanged.

  - **ORM-neutral constraint AST** (`@adonis-agora/authz`): `ScopeConstraint` (`scopeAll` / `scopeNone` / condition tree) with builders `eq`, `whereIn`, `where`, `and`, `or`, `normalizeScope`, and the `assertSafeIdentifier` injection guard — ported from nestjs-authz's core scope model.
  - **`ScopeRegistry`**: register a scope filter per resource (model class or string name); fail-closed — an unregistered resource is deny-all. Each filter receives the user's effective roles/permissions/tenant (the SAME authz data `can` consults), so it derives its `WHERE` without re-querying.
  - **`AuthzService.scope(user, resource, { action?, scope? })`**: resolves the constraint mirroring `can`'s order — super-admin (hook or global role) → wildcard permission grant for the action → registered filter → deny-all.
  - **Lucid adapter** (new subpath `@adonis-agora/authz/scope`): `accessibleBy(query, service, user, resource, opts?)` resolves + applies the scope to a Lucid query builder; `applyScopeConstraint(query, constraint)` is the primitive. `allow-all` adds nothing, `deny-all` adds `1 = 0`, conditions compile to parameterized, identifier-safe `where`/`whereIn`/`whereNull` clauses wrapped in their own group so they compose with existing clauses.
  - **Config**: `defineConfig({ scopes })` accepts a `ScopeRegistry` or a `(registry) => void` builder; the provider threads it into the container `AuthzService`.

## 0.3.0

### Minor Changes

- [`41cb5a9`](https://github.com/DavideCarvalho/adonis-authz/commit/41cb5a963451d06eb222e4a79acec0dca6474b8f) - Add four opt-in Agora integration features (all default-OFF, structural — no hard deps):

  - Tenant auto-scope: `resolveTenant: tenantFromContext` (or a custom resolver) defaults an unscoped check's tenant to the active Agora context's `tenantId`.
  - Global-role bridge (read-time, no seeding): `superAdminRoles` short-circuits allow; `globalRoleGrants` unions global-role permissions into checks. Global roles are read structurally from the Agora context store (`globalRoles`).
  - Event-driven provisioning: `defineAuthzProvisioning(config)` (new subpath `@adonis-agora/authz/provisioning`) subscribes to authkit diagnostics events via the optional `@adonis-agora/diagnostics` peer and runs config-mapped actions against the store (best-effort, never throws).
  - `POST /authz/can` endpoint: `registerCanEndpoint(router, opts)` (new subpath `@adonis-agora/authz/http`) returns `{ allowed }` for `{ permission, resource? }`.

- [`cdd293e`](https://github.com/DavideCarvalho/adonis-authz/commit/cdd293e506792c1e4c0632987a6b5675fed2942b) - fix: consistent super-admin across can/hasRole/hasAnyRole; collapse super-admin layers; drop resolveTenant:'context' magic string; tighten DiagnosticEvent/CanHttpContext types

  - **Bug fix:** `hasAnyRole` now honors the `superAdmin` hook and global super-admin roles, matching `can` and `hasRole`. Previously a global/hook super-admin got `true` from `hasRole('x')` but `false` from `hasAnyRole(['x'])`.
  - The two parallel super-admin mechanisms (the `superAdmin` hook and `superAdminRoles`/global roles) are collapsed into a single private guard used identically by `can`, `hasRole`, and `hasAnyRole`. Global permission grants (`globalRoleGrants`) are now folded into the single permission-union site in `can` only — role checks never consult permission grants.
  - **Breaking (pre-1.0):** `resolveTenant` no longer accepts the `'context'` magic string; pass a resolver instead. Use the exported `tenantFromContext` for the previous built-in behavior: `resolveTenant: tenantFromContext`.
  - Tightened contracts: dropped the open `[key: string]: unknown` index signatures from `DiagnosticEvent` and `CanHttpContext` so the documented typed fields narrow.

## 0.2.0

### Minor Changes

- [`00e3562`](https://github.com/DavideCarvalho/adonis-authz/commit/00e35620529d659607c750f0adc1a04b7075a420) - Add identityUserRef seam for pairing with an authentication provider (e.g. AuthKit)

- [`518aa72`](https://github.com/DavideCarvalho/adonis-authz/commit/518aa720ca2346edd84b4b539ff31e4661222c33) - Require AdonisJS v7 (bump @adonisjs/\* peers; Bouncer 4, Lucid 22)
