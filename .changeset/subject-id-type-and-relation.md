---
'@adonis-agora/authz': minor
---

The Lucid pivot now respects integer-id hosts natively: `stores.lucid({ userIdType: 'integer' })`
(and the same option on `createAuthzTables` / the published migration) creates INTEGER `user_id`
columns, so Lucid binds the model's numeric id against a matching column type — `preload('roles')`
matches with the DEFAULT relation on any table, any PK name, every dialect. No getter, no `localKey`.

Defaults are unchanged (`'text'`, which still fits every subject kind in one table); mixed apps
(integer users *and* UUID subjects) keep TEXT plus the `localKey` recipe. Non-integer ids against
INTEGER pivots fail LOUD on write instead of silently matching nothing. The shared contract suite
runs on both column types, and the relation specs prove zero-ceremony preload (including a
non-`users` table with a non-`id` PK) on SQLite, Postgres and MySQL.
