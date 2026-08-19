---
'@adonis-agora/authz': patch
'@adonis-agora/authz-react': patch
---

Fix `engines.node`, which was published as the exact version `v26.7.0` instead
of a supported range. Every consumer on any other Node version got an engine
warning on install, and installs under `engine-strict` failed outright. The
field is back to `>=20.6.0`, and Renovate no longer treats it as a pinnable
dependency.
