---
"@adonis-agora/authz": patch
---

Upgrading from 0.14 or earlier no longer loses every role. 0.15 renamed the subject pivots (`authz_user_role` / `authz_user_permission`, columns `user_type` / `user_id`) to `authz_subject_role` / `authz_subject_permission` with `subject_*` columns, but nothing renamed an existing install: booting it created new, empty pivots next to the old ones, and every subject silently lost its roles and direct permissions.

`createAuthzTables` (run at boot under `autoCreateSchema`, and by the published migration) now carries an old install over before creating the pivots:
- **still on ≤ 0.14:** the old tables are renamed, columns included;
- **a pivot that kept its own table name:** its `user_*` columns are renamed;
- **already booted on 0.15–0.18** (empty new tables next to the old ones): the old rows missing from the new tables are copied in, and the old tables are kept as `authz_user_role_pre_subject` / `authz_user_permission_pre_subject`, so a role revoked since is never copied back.

Nothing is dropped, and a later boot finds nothing to do. With `autoCreateSchema: false`, add a migration that calls `createAuthzTables()` again.
