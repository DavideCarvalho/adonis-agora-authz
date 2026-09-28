---
'@adonis-agora/authz': minor
---

Per-source role assignments: every role assignment now records a `source` (default `'manual'`, backwards compatible), so SSO/SCIM-synced roles and manual grants can coexist.

- `assignRole(user, role, { tenantId?, source? })`: idempotent per source.
- `removeRole(user, role, { tenantId?, source? })`: without `source` it removes the role from **every** source, which is what it did before; with `source` it removes only that source's assignment.
- New `setSubjectRoles(user, roles, { source?, tenantId?, client? })`: replaces only that source's assignments in that exact tenant scope, leaving other sources and tenants untouched. On the Lucid store it runs in one transaction, or joins the client you pass.
- New `getRoleAssignments(user, scope?)`: returns `Array<{ role, source, tenantId: string | null }>`.
- A role held via two sources is two rows. `getRolesForSubject`, `getSubjectsForRole`, `countSubjectsForRole` and `countSubjectsByRole` stay distinct, so a role is never listed or counted twice.
- `authzRolesRelation()` preloads a role once even when several pivot rows match, and accepts a `source` filter.
- The mixin's `assignRole`/`removeRole` accept `source`. New exports: `DEFAULT_ROLE_SOURCE`, `MAX_ROLE_SOURCE_LENGTH` (64), `normalizeRoleSource`, and the types `RoleAssignment`, `RoleAssignmentScope` and `SetSubjectRolesOptions`.
- Custom `PermissionStore` implementations must add `setSubjectRoles` and `getRoleAssignments`. The shared contract suite in `@adonis-agora/authz/testing` covers both.

**Migration notes (Lucid store, existing databases).**

1. The `source` column is added to `authz_subject_role` on its own, without touching existing data: `ensureSchema()` / `createAuthzTables()` run `ADD COLUMN source VARCHAR(64) NOT NULL DEFAULT 'manual'`, and existing rows become manual. With `autoCreateSchema: false`, run a migration that calls `createAuthzTables(db)` again.
2. You must widen the primary key by hand, once, so that the same role can be held from two sources. Until you do, a second source's insert is silently ignored.
   - **Postgres:**
     `ALTER TABLE authz_subject_role DROP CONSTRAINT authz_subject_role_pkey; ALTER TABLE authz_subject_role ADD PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source);`
   - **MySQL:**
     `ALTER TABLE authz_subject_role MODIFY role_id VARCHAR(191) CHARACTER SET ascii NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source);`
     The ASCII `role_id` keeps the 5-column key under InnoDB's 3072-byte limit.
   - **SQLite:** rebuild the table. See the docs ("Role sources" in `docs/roles.mdx`) for the exact script.

New tables are created with the widened key.
