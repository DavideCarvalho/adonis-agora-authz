---
'@adonis-agora/authz': minor
---

**`authzRolesRelation()` now works with any host key — integer, bigint or uuid, on any table, with
any PK name — and nothing to declare on the model.** Lucid used the model's key as-is both in the
`WHERE subject_id IN (…)` it binds (SQLite does not coerce a numeric binding to a TEXT column) and in
the strict-equality distribution of preloaded rows, so an `increments()` model preloaded `[]` with
no error (#74). The relation now normalizes both on its first query: it points `localKey` at a
plain string getter it defines on the model's prototype (not a `@column` — no hydration, serialize
or save impact) and distributes rows comparing both sides as strings. `preload`, `load` and
`related().query()` are covered on TEXT and INTEGER/BIGINT pivots, on SQLite, Postgres (including
`bigint` PKs, which arrive as strings) and MySQL. `localKey` now defaults to the model's primary
key instead of a hard-coded `'id'`. The 0.14.x `@column` getter + `localKey: 'idAsText'` recipe is
no longer needed (an explicit `localKey` is still honored).

**Native key-type pivots:** `stores.lucid({ subjectIdType: 'integer' | 'bigint' })` (same option on
`createAuthzTables` / the published migration) creates INTEGER / BIGINT `subject_id` columns — the
host's own key shape (`increments()` / `bigIncrements()`), enabling a foreign key to it. This is a
storage choice, never a correctness one; the default stays `'text'`, which fits every subject kind
in one table. Non-integer ids against integer pivots fail LOUD on write instead of silently matching
nothing. The shared contract suite runs on all three column types.

**Vocabulary: `user*` → `subject*` (breaking, pre-1.0, no aliases).** The store is polymorphic —
a "user" was always any row holding roles — so the API now says so: `SubjectRef` / `SubjectRefInput` /
`ResolveSubjectRef`, `resolveSubjectRef` (config), `normalizeSubjectRef` / `defaultResolveSubjectRef` /
`identitySubjectRef`, store methods `getRolesForSubject`, `getPermissionsForSubject`,
`giveSubjectPermission`, `revokeSubjectPermission`, `subjectHasPermission`, `getSubjectsForRole`,
`countSubjectsForRole`, `countSubjectsByRole`, service `subjectsWithRole`; `AuthzTableNames.subjectRole` / `subjectPermission`
(default tables `authz_subject_role` / `authz_subject_permission`, columns `subject_type` /
`subject_id`); `authzRolesRelation({ subjectType })`. Existing installs (if any) rename the two
pivot tables and their two columns; no other data changes.
