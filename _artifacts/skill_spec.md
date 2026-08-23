# Skill spec — adonis-authz (autonomous pass)

ONE domain map (see `_artifacts/domain_map.yaml`) covers the whole monorepo. Both
packages are consumer-facing and covered; skills are co-located per package.
No maintainer interview ran — priorities are inferred from docs callouts and
source assertions, and the gaps are recorded at the bottom and in the map.

## Scope decision

| Package | Version | Skills | Why |
|---|---|---|---|
| `@adonis-agora/authz` | 0.10.5 | 5 | The library's mental model lives here: install/config, the decision surface (`can`/`hasRole`/wildcards/super-admin), roles+tenancy reconciliation, query scopes, route middleware. |
| `@adonis-agora/authz-react` | 0.2.1 | 1 | The frontend mirror: one Inertia share helper on the server, three client primitives + matcher. Small enough for a single skill. |

Total: 6 SKILL.md files. Flat structure (`skills/<name>/SKILL.md`, names
prefixed `authz-`), all `type: core`, no router skill.

## Skills

1. **core / authz-setup** — install, `node ace configure @adonis-agora/authz`,
   published files (`config/authz.ts`, `app/abilities/authz.ts`, migration),
   `defineConfig({ default, stores })` with `stores.lucid()/stores.memory()`,
   `autoCreateSchema` vs owning the schema via `createAuthzTables`/`dropAuthzTables`
   + matching `tables` overrides, ace commands (`authz:grant`, `authz:assign`,
   `authz:list`, `authz:sync`) and the idempotent `catalog`. Mistakes: shipping
   `autoCreateSchema` default to production; divergent `tables` overrides between
   store and schema helpers; expecting `authz:sync` to revoke.

2. **core / authz-decisions** — answering may-I questions:
   `defineAuthzAbilities(service)` / `authzAbilities(thunk)`, the published
   `#abilities/authz` import, `ctx.bouncer.allows/authorize/denies`, Edge `@can`,
   the service singleton vs container class split, `can(user, permission,
   { scope, cache })`, `effectivePermissions`, wildcard rules
   (`permissionSatisfied`, not `includes`), super-admin hook/roles resolution,
   per-request `PermissionCache`. Mistakes: `Array.includes` over wildcard sets;
   assuming `can` inspects its `resource` arg; module-scope cache hoisting;
   treating a superAdmin-hook `false` as fall-through.

3. **core / authz-roles-tenancy** — authz as the single authority on roles:
   `effectiveRoles` union (token ∪ `resolveRoles` ∪ store), reverse lookup
   `usersWithRole` + reverse seams `resolveRoleMembers`/`resolveGlobalRoleMembers`,
   `roleGrants`, `superAdminRoles` (global-context-only), tenancy visibility
   rules (`GLOBAL_TENANT`, `normalizeTenant`, tenant sees global ∪ own; direct
   grants are tenant-independent), Agora bridges (`tenantFromContext`,
   `resolveTenant`). Mistakes: checking roles through the auth provider; wiring
   `resolveRoles` without `resolveRoleMembers`; assigning `superAdminRoles`
   outside the global context; expecting direct grants to be tenant-scoped.

4. **core / authz-query-scopes** — filtering collections at the DB layer:
   fail-closed unregistered resources, `scopes` config builder,
   `ScopeRegistry.register(Model|string, filter)`, `ScopeFilterContext`
   (`user/action/permissions/roles/tenant`), the constraint DSL (`eq`, `where`,
   `whereIn`, `and`, `or`, `scopeAll`, `scopeNone`; empty-group identities),
   `accessibleBy(query, authz, user, resource, { action })` two-await contract,
   resolve/apply split via `authz.scope()` + `applyScopeConstraint()`.
   Mistakes: top-level `orWhere` leaking rows past deny-all; misreading
   deny-all emptiness as data; awaiting once and treating the builder as rows.

5. **core / authz-route-guards** — `AuthzRoleMiddleware` as named middleware
   `requireRole`: any-of `roles`, `scope`, `guestRedirect`/`deniedRedirect`/
   `deniedMessage`, effective-role engine (token claims match without seeding).
   Deliberately role-only — permission checks belong to Bouncer in actions,
   collections to query scopes. Mistakes: forcing permissions through it;
   seeding store roles to satisfy token claims; missing redirects for SSR apps.

6. **react / authz-react-ui** — frontend parity: `buildAuthzShare(authz, user,
   scope?)` in Inertia `sharedData`, typing the prop with `AuthzSharedProps`,
   `useAuthz()` precedence (provider > shared prop > empty share), `useCan`,
   `<Can permission|role fallback>` semantics, client-safe
   `permissionMatches`/`permissionSatisfied`, testing via `<AuthzProvider>`.
   Mistakes: importing `buildAuthzShare` from the client barrel; passing both
   `permission` and `role` to `<Can>` expecting AND; mocking `usePage` instead of
   using `<AuthzProvider>` in tests.

## Frontmatter contract (per `intent validate`)

- Top-level only: `name`, `description`, `metadata`, `sources`.
  `name` = kebab leaf == parent dir (the `authz-` prefix lives in dir + name).
- `metadata`: `{ type: core, library, library_version, framework? }`.
- Body order: Setup → 2–4 Core Patterns → ≥3 Common Mistakes
  (Wrong/Correct real code + mechanism + Source).

## Coverage notes

- Bouncer abilities are static by design (`can`, `hasRole`); policies remain the
  tool for object-level checks — recorded as a cross-skill tension rather than a
  separate skill.
- Ace commands are folded into **authz-setup** (they are thin store wrappers);
  provisioning (`@adonis-agora/authz/provisioning`) and `/authz/can`
  (`registerCanEndpoint`) are mentioned where relevant but not given their own
  skill — both are optional, opt-in surfaces documented inside decisions/setup
  scope. Recorded as a gap if maintainers want them expanded.

## Remaining Gaps (what a maintainer interview would have answered)

- **Priorities unknown.** No interview; which failure modes bite hardest
  (e.g. orWhere leakage vs unregistered-scope confusion) is inferred from doc
  callout strength (warn Callouts → CRITICAL/HIGH).
- **Staging guidance for autoCreateSchema.** Docs say "turn it off in production"
  but never bless staging use; skill phrases it as production-focused advice.
- **RBAC + ownership composition.** Docs show sequential checks (ability then
  policy); no canonical single-call pattern exists in-repo.
- **Provisioning & /authz/can depth.** Opt-in integrations kept shallow; whether
  they warrant dedicated skills is a maintainer call.
- **No GitHub issue mining.** Real-world AI-agent failure reports were not
  consulted this pass (gh not verified against this repo's issues).
