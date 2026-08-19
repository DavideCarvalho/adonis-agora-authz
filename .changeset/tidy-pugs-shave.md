---
'@adonis-agora/authz': patch
---

Fix `node ace configure @adonis-agora/authz`, which failed on every published
version. Adonis renders a stub body through Tempura, which compiles it into a
JavaScript template literal, so a backtick in the body terminates that literal
early. All three stubs carried backticks in their doc comments, so `configure`
threw `Unexpected identifier 'memory'` before writing a single file. The doc
comments now use quotes; the `{{{ … }}}` header, which is evaluated as
JavaScript, is unaffected.
