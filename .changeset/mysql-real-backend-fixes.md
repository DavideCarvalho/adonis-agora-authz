---
'@adonis-agora/authz': patch
---

The schema and store now run against a real MySQL 8, which they previously did not — the new testcontainers suite (`pnpm --filter @adonis-agora/authz test:db`, also on CI) executes the full contract on Postgres 16 and MySQL 8 and immediately found two MySQL-only defects:

- `createAuthzTables` emitted `CREATE [UNIQUE] INDEX IF NOT EXISTS`, which MySQL 8 rejects outright (a MariaDB extension). Index DDL now drops the guard on MySQL and swallows the duplicate-key error, preserving idempotency; every other dialect keeps `IF NOT EXISTS`.
- MySQL raw `SELECT`s resolve to the node-mysql `[rows, fields]` pair, so the store read every result as one bogus row. The row normalizer now unwraps that shape (it is also more correct for empty result sets on any driver).

No behavior change on SQLite/Postgres; custom stores are unaffected.
