---
'@adonis-agora/authz': minor
---

Organization as tenant: with `@adonis-agora/context` tenancy on, checks default to the active tenant's scope; new `tenancy` option (`enabled`, `kinds`, `family`, `roles` to map the caller's org role to authz roles in that tenant); `authorizeByRoles({ allTenants })` returns `tenants: '*'` for console viewers who may see every organization.
