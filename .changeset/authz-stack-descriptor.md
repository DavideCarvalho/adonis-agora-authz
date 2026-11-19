---
"@adonis-agora/authz": patch
---

The `defineConfig` result now describes the active store (a Lucid store's connection, the app's default when omitted) and `CerbosDecisionProvider` describes Cerbos (`Symbol.for('@adonis-agora/stack')`), so telescope's Architecture page shows "authz: permissions → PostgreSQL" without any app code.
