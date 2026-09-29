---
'@adonis-agora/authz': minor
---

Admin management operations on the `PermissionStore` (Lucid and memory stores, plus the shared contract suite):

- `deleteRole(name)` now returns `Promise<boolean>`: whether the role existed. It runs in one transaction on Lucid, or joins the host client when given one. It still removes grants and every assignment (all tenants, all sources) together with the role row.
- `syncRolePermissions(role, permissionNames)` replaces a role's grants with exactly this list (spatie's `syncPermissions`), creating the role and permissions by name. It is atomic.
- `getPermissionsForRoles(roleNames)` returns `{ [role]: sortedPermissionNames }` in one query. Every existing role is a key, with `[]` when it has no grants. Unknown roles are absent.
- `listRoleAssignments({ tenantId?, role?, subject?, source? })` returns raw `{ subjectType, subjectId, role, source, tenantId }` rows for admin listings, ordered by `(subjectType, subjectId, role, source, tenantId)`. Leaving `tenantId` out lists every tenant, `null` lists global rows only, and a string lists **only** that tenant's scoped rows, without the global ones.
- `removeSubject(user)` deletes every role assignment (all tenants, all sources) and every direct grant of the subject. It is atomic and meant for account deletion.

New exports: the `RoleAssignmentFilter` and `SubjectRoleAssignment` types, plus the `compareSubjectRoleAssignments` and `roleFilterNames` helpers.

Custom `PermissionStore` implementations must add the four new methods and return a boolean from `deleteRole`. `runPermissionStoreContract` covers all of them.
