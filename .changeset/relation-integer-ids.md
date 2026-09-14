---
'@adonis-agora/authz': minor
---

`authzRolesRelation()` gains `localKey` (closes #74). The pivot stores `user_id` as TEXT (the authz is polymorphic — UUID hosts included), but Lucid distributes preloaded pivot rows with STRICT JS equality: an `increments()` user (`id: 42`) never matched the pivot (`'42'`), so `preload('roles')` returned `[]` **with no error** for every integer-id host — the silent failure the function exists to prevent.

Integer-id recipe: expose the id as text (`@column({ columnName: 'id', consume: String, serializeAs: null })`) and pass `authzRolesRelation({ localKey: 'idAsText' })`. Default `localKey: 'id'` — string/UUID hosts change nothing. New runtime specs preload through real Lucid models with integer and text ids, and a tripwire documents the un-patched silent-empty behavior.
