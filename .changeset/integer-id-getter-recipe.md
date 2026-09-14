---
'@adonis-agora/authz': patch
---

Correct the integer-id `localKey` recipe from 0.14.0 (#84): a second plain
`@column` over the same column steals `id`'s hydration slot — roles preload
fine so the recipe *looked* right, but the model hydrated with `id: undefined`.
The documented recipe is now a `@column`-registered getter on the same column,
declared before `id`, so `id` keeps the slot and the getter feeds the
relation's key extractor. No runtime changes; `lucid_relation_models.spec.ts`
now asserts both `id` and `roles` for the working shape, plus a tripwire
documenting the broken shape.
