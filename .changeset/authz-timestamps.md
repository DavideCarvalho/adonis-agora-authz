---
"@adonis-agora/authz": minor
---

createdAt / updatedAt: roles and permissions now have `created_at` + `updated_at`, and role grants, role assignments and direct grants get `created_at` (they are never edited). Existing tables get the missing columns at boot (`NULL`-able, no default, no backfill — older rows have no value); a role's `updatedAt` moves whenever its permission set changes. New: `store.listRoleRecords()` / `listPermissionRecords()` (optional on custom stores) return `{ name, createdAt?, updatedAt? }`; `getRoleAssignments` / `listRoleAssignments` rows gain an optional `createdAt`. `authz:roles:list`, `authz:permissions:list`, `authz:assignments:list` and the `authz_list_roles` dev tool show them (ISO 8601 or `null` in JSON). Stores take an optional `now` clock. `syncRolePermissions` now diffs instead of rewriting every grant, so kept grants keep their `created_at`. Also exports `toTimestamp` / `timestampJson`.
