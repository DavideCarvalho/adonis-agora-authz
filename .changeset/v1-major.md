---
"@adonis-agora/authz": major
"@adonis-agora/authz-react": major
---

1.0.0.

**Security:** the effective roles of a subject no longer include the current request caller's global (token) roles. Before, `effectiveRoles`, `effectivePermissions`, `can`, `hasRole`, `hasAnyRole`, query scopes and `superAdminRoles` added the caller's token roles to ANY subject they were asked about, so a request made by an admin reported other users as holding ADMIN. A host whose token-minting hook (authkit `resolveTokenRoles`) reads `authz.effectiveRoles(...)` could put ADMIN into another user's token when an admin's request triggered the minting (impersonation, token exchange). The context's roles now apply only to the subject the context names (`userRef`, same type and id).

Breaking changes:

- `@adonis-agora/authz` no longer renames the pre-0.15 subject pivots (`authz_user_role`, `authz_user_permission`, and `user_type` / `user_id` columns) to `authz_subject_*` / `subject_*` when the store creates its schema. Rename them with a migration before upgrading; see the "Migrating to 1.0" docs page.
- `requireRole` and `authorizeByRoles` get the user from the `@adonisjs/auth` guard (`ctx.auth.user`) and no longer call `ctx.auth.getUser()`. When no auth middleware ran on the route (for example the dashboards' own routes), they call `ctx.auth.check()` first, so a global `silentAuth` is not needed for authz.
- Node.js 24 or newer is required.
- `@adonis-agora/authz-react` now accepts `@adonis-agora/authz` up to `<2.0.0` (1.0 release candidates included), and `@adonis-agora/authz` accepts `@adonis-agora/diagnostics` up to `<2.0.0`.
- The caller's context roles only count for the caller (see Security above). A custom setup that writes `globalRoles` into the Agora context without a `userRef` no longer grants those roles to anyone.
- `@adonis-agora/authz-react` accepts `react` and `react-dom` `^19.0.0`.
- New: `resolveAuthUser(ctx.auth)` (from `@adonis-agora/authz`) returns the signed-in user and authenticates on demand; use it in the Inertia share: `buildAuthzShare(authz, await resolveAuthUser(ctx.auth))`.
