---
'@adonis-agora/authz': patch
---

Fix the `accessibleBy` JSDoc example: it called `.exec()` on the returned
Promise. `accessibleBy` resolves to the query builder, so the rows come from
awaiting (or `.exec()`-ing) the builder the Promise resolves to.
