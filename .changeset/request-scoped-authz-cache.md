---
"@adonis-agora/authz": patch
---

Checks inside one request now share a single role read and permission read per user and tenant by default. Without an explicit `cache`, `can`, `check`, `canMany`, `hasRole`, `hasAnyRole`, `scope`, `effectiveRoles` and `effectivePermissions` use a cache bound to the current request (the `@adonis-agora/context` store, or `HttpContext` when `useAsyncLocalStorage` is on), so `user.can()`, the Bouncer abilities and `/authz/can` stop issuing three queries per check. The granted set (plus `roleGrants`) is compiled once per entry, so a check is a hash lookup plus a scan of the wildcard grants only. Grants changed mid-request apply from the next request; a failed read is retried rather than cached.
