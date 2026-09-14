---
'@adonis-agora/authz': minor
---

`PermissionCache` now memoizes the ROLE resolution too, not just the permission read (closes #75). `can()` consulted `effectiveRoles` — the token's global roles, the `resolveRoles` seam **and** `store.getRolesForUser` — on every call, so a page with eight checks paid sixteen membership queries and `{ cache }` changed nothing for them.

`service.createCache()` binds the service's own effective-roles union as the cache's role source; `effectiveRoles`, `effectivePermissions`, `hasRole`, `hasAnyRole` (and `scope`) now accept `{ cache }`. Snapshot semantics preserved — the cache still never invalidates, so every check in a request decides against the same state, now for roles too.
