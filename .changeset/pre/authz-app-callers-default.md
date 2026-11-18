---
'@adonis-agora/authz': minor
---

`requireRole` checks an app calling this one (`ctx.agora.caller`) with no option: its token carries what the Hub granted it, so a route only names the permission, and an app without the grant gets `403`. The `appCallers` option is gone.
