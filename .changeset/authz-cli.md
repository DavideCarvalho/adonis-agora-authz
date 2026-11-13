---
'@adonis-agora/authz': minor
---

CLI parity with the authz MCP tools. New `authz:<noun>:<verb>` ace commands: `authz:roles:list` (store, `roleGrants`, catalog and drift), `authz:roles:revoke`, `authz:permissions:list`, `authz:assignments:list`, `authz:assignments:remove`, `authz:subjects:grant`, `authz:subjects:revoke`, `authz:subjects:roles`, `authz:subjects:permissions` and `authz:subjects:explain`. Every command takes `--json`; lists page with `--page` / `--size` and print `{ data, meta }`; revocations ask first and need `--force` without a terminal. The reads share one implementation with the MCP tools (`authzQueries`, `authzDevToolsDepsOf`).

BREAKING: `authz:grant` is now `authz:roles:grant`, `authz:assign` is now `authz:assignments:add` (new `--source` flag), and `authz:list` is replaced by `authz:roles:list` + `authz:permissions:list`. No aliases.
