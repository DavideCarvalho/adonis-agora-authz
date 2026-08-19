---
'@adonis-agora/authz': patch
---

Fix the published migration stub, whose `up()` did not compile in a consumer
app. `createAuthzTables` accepts a structural `LucidDatabase` whose `rawQuery`
declared `bindings?: readonly unknown[]` — not assignable in either direction to
Lucid's `RawQueryBindings`, since `readonly unknown[]` cannot go into the
mutable `StrictValues[]` and the named-map branch is not an array. No real query
client satisfied the interface, so `this.defer((db) => createAuthzTables(db))`
was a type error for anyone who ran the migration.

The mirrored binding type is now `readonly unknown[] | Record<string, unknown>`,
which Lucid's own union fits into, and it is exported as `LucidQueryBindings`.
