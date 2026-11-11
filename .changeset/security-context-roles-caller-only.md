---
"@adonis-agora/authz": patch
---

**Security: request caller's roles applied to other subjects (privilege escalation).** In 0.x, effective-role resolution (`effectiveRoles`, `effectivePermissions`, `can`, `hasRole`, `hasAnyRole`, query scopes, `superAdminRoles`) added the current request's global token roles to *any* subject being evaluated. Code running in an admin's request therefore treated other users as admins. In hosts that mint token roles from authz (for example authkit's `resolveTokenRoles` calling `authz.effectiveRoles`), an admin-initiated flow such as impersonation or token exchange could issue another user a token carrying the admin's roles. Fixed in 0.20.2 and 1.0.0: context roles apply only to the subject the context identifies (`userRef`, same type and id). If you write `globalRoles` into the Agora context yourself, also write `userRef`.

`subjectRefFromContext()` now also reads `userRef` (the accessor method `@adonis-agora/context` publishes, then the `userRef` key authkit writes into the store), not only `subjectRef()`.
