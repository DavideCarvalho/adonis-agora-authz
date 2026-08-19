---
"@adonis-agora/authz": patch
---

`DiagnosticEvent` passa a descrever o payload que o authkit REALMENTE publica

O tipo declarava só `{ type, metadata }`, com o comentário sugerindo ler
`metadata.orgId`. Mas o authkit redige o evento antes de colocá-lo no
barramento (`redactAuditEventForDiagnostics`): `email`, `ip` e `metadata` saem
fora por LGPD. Ou seja, uma `ProvisioningAction` escrita seguindo o tipo lia
`undefined` em produção — e o teste que cobria isso injetava um payload
sintético com `metadata`, que o authkit nunca emite, então passava sem medir
nada (os `*.spec.ts` também estão no `exclude` do tsconfig, então nem o
typecheck pegava).

O tipo agora expõe `accountId`, `actorId`, `clientId` e `orgId` no topo,
espelhando a projeção real, e documenta que `metadata` só chega quando o host
alimenta o barramento por conta própria. Requer `@adonis-agora/authkit-server`
com o `orgId` de primeira classe para o campo vir preenchido.
