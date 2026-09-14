---
'@adonis-agora/authz': minor
---

`PermissionStore` gains a transaction seam so a grant can join a `db.transaction` the host already opened (closes #77), in three layers with the most local winning per call:

- every data method accepts a trailing `opts?: { client }` — the Lucid-style per-call escape hatch;
- `store.withClient(trx)` returns a view that IS a `PermissionStore` bound to the client — bind once, every call on it joins the transaction (Kysely's `trx`-is-the-db idiom);
- `stores.lucid({ resolveClient })` (config) reads an ambient client (the host's idiom: a tiny `AsyncLocalStorage` around `db.transaction`) so plain calls auto-join.

A client-bound call never touches the root connection — no DDL, no pool waits — so `ensureSchema`/auto-create must have run before the transaction opened. The memory store ignores the client and `withClient` returns `this`. `AuthzService.can`/`hasRole` and the check APIs are untouched; purely additive.
