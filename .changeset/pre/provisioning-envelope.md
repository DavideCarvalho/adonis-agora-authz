---
'@adonis-agora/authz': patch
---

Provisioning actions now receive the authkit event itself on the real `@adonis-agora/diagnostics` bus. The bus delivers an envelope (`{ v, ts, lib, event, traceId, payload }`), and actions were getting that envelope, so `ev.accountId` and `ev.orgId` were `undefined`. Events re-emitted by authkit-client's `registerAuthkitWebhook` (authkit on another server) provision exactly like in-process ones. Docs: how to point authkit-server's `events.webhook` at each app.
