---
"@adonis-agora/authz": major
"@adonis-agora/authz-react": major
---

1.0.0. Breaking changes:

- `@adonis-agora/authz` no longer renames the pre-0.15 subject pivots (`authz_user_role`, `authz_user_permission`, and `user_type` / `user_id` columns) to `authz_subject_*` / `subject_*` when the store creates its schema. Rename them with a migration before upgrading; see the "Migrating to 1.0" docs page.
- `requireRole` and `authorizeByRoles` get the user from the `@adonisjs/auth` guard (`ctx.auth.user`) and no longer call `ctx.auth.getUser()`. When no auth middleware ran on the route (for example the dashboards' own routes), they call `ctx.auth.check()` first, so a global `silentAuth` is not needed for authz.
- Node.js 24 or newer is required.
- `@adonis-agora/authz-react` now accepts `@adonis-agora/authz` up to `<2.0.0` (1.0 release candidates included), and `@adonis-agora/authz` accepts `@adonis-agora/diagnostics` up to `<2.0.0`.
