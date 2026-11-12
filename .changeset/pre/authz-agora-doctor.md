---
'@adonis-agora/authz': minor
---

`node ace agora:doctor` (the shared Agora health check) and `node ace authz:doctor`, with authz checks `authz.config`, `authz.super-admin`, `authz.tenancy`, `authz.store-reachable` (deep) and `authz.catalog-sync` (deep: catalog roles, permissions or grants missing from the store). New `@adonis-agora/authz/doctor` entry for `--no-boot`.
