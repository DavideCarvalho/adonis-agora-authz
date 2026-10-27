---
"@adonis-agora/authz-react": patch
---

perf: `useCan` and `<Can>` compile the share's `permissions` array once (exact grants in a `Set`, only wildcard grants pre-split) and reuse it for every gate that reads the same array, instead of scanning and splitting every grant per gate per render. Matching semantics are unchanged.
