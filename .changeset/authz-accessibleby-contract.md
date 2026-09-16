---
'@adonis-agora/authz': patch
---

Corrige o contrato documentado de `accessibleBy` e aceita o singleton do `services/main`.

O helper é `async` e devolve o query builder do Lucid, que é **thenable** (`then()` roda `exec()`). Retornar um thenable de uma função `async` faz o JavaScript assimilá-lo: a promise resolve para **as linhas**, não para o builder. A documentação dizia o contrário — `docs/concepts.mdx` ("so there are two awaits"), `docs/query-scopes.mdx`, a skill `authz-query-scopes` e o JSDoc de `lucid_scope.ts` ("await it once for the constraint and again (or `.exec()`) for the rows") — então todo consumidor que seguisse a doc escrevia `(await accessibleBy(...)).orderBy(...)` / `.exec()` e quebrava em runtime com `TypeError`, sem o `tsc` reclamar (a assinatura declara `Promise<Q>`).

Agora a doc, a skill e o JSDoc dizem o que acontece de verdade (o await já executa e resolve para as linhas) e mostram o caminho para quem precisa **encadear depois do scope**: resolver as duas metades na mão — `authz.scope()` + `applyScopeConstraint()`, que é síncrona e nunca executa. Era o que o comentário do próprio teste de integração já dizia; o texto de fora é que ficou para trás.

Junto, `accessibleBy` passa a aceitar o que de fato consome: `ScopeResolvingService` (`Pick<AuthzService, 'scope'>`). Antes o parâmetro era o `AuthzService` completo, então o singleton `@adonis-agora/authz/services/main` — um `Pick` que expõe `scope` — era **rejeitado pelo tipo**, e os exemplos da doc (que passam o singleton) não compilavam. A mudança é um alargamento: quem já passava um `AuthzService` completo continua igual.

Testes novos em `test/scope_integration.spec.ts` fixam o valor resolvido (linhas, e não builder), o encadeamento via `applyScopeConstraint` e a aceitação do singleton — para uma futura inversão desse contrato (que seria breaking) ter de ser decisão explícita.
