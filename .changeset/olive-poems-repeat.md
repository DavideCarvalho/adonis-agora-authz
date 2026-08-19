---
'@adonis-agora/authz': patch
---

Fix the `@adonis-agora/diagnostics` peer range, which was unsatisfiable by every
published version of that package. Under semver a caret does not cross a minor
below 1.0, so `^0.1.0` meant `>=0.1.0 <0.2.0` while diagnostics had moved on to
0.2.6. pnpm degrades an unsatisfied peer to a warning, but npm treats it as
`ERESOLVE` and refuses to install — even though the peer is optional — so any
app depending on both packages could not install under npm.

The range is now `>=0.1.0 <1.0.0`. The floor is the earliest published version
carrying the `onDiagnostic` subscriber authz actually calls, which is 0.1.0:
that entry point is byte-identical across every release from 0.1.0 to 0.2.6.
