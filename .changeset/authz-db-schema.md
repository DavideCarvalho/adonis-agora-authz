---
'@adonis-agora/authz': minor
---

`schema` on `stores.lucid()`: keep the RBAC tables in their own Postgres schema (MySQL: database), created on first use when `autoCreateSchema` is on. Every statement names it (`"authz".authz_roles`), including those run on the app's transaction, so nothing depends on `search_path` and it is safe behind PgBouncer in transaction mode. `createAuthzTables`/`dropAuthzTables` and `authzRolesRelation()` take `schema` too. A `schema` on SQLite fails the boot. `agora:doctor --deep` gains `authz.schema` when it is set.
