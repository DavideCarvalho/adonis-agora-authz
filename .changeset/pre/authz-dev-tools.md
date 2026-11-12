---
'@adonis-agora/authz': minor
---

Dev MCP tools on `@adonis-agora/agent`'s `/mcp/agora` endpoint (gated by the endpoint's `devTools.authorize`): `authz_explain_check`, `authz_list_effective_roles`, `authz_list_effective_permissions`, `authz_list_roles` (with catalog vs store drift). New `devTools` option in `config/authz.ts` (`false`, or `{ loadSubject, loadResource }`), and service methods `checkForRef`, `explainCheck`, `effectiveRoleSources`.
