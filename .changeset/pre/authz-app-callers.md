---
'@adonis-agora/authz': minor
---

Apps calling this app are subjects. `ctx.agora.caller` (an authkit service token) is checked as `{ type: 'app', id: <name> }`: its token's capabilities count as permissions (Agora capability rule, `media:*`), alongside its roles and permissions in authz, `resolveRoles`, `roleGrants`, the `superAdmin` hook and the decision provider. New: `permitAuthz()` (the `permit` for the libs' `authorizeAppCaller` seams), `requireRole({ appCallers: true })`, `appSubjectRef`, `appCallerOf`, `capabilityAllows`, `APP_SUBJECT_TYPE`.
