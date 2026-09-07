---
'@adonis-agora/authz': patch
---

Corrige `tenantFromContext` (e adiciona `userRefFromContext`) para ler o accessor do `@agora/context` como MÉTODOS, não como valores — bug silencioso que fazia o escopo por tenant resolver para uma função em vez do tenant real.

`@adonis-agora/context@0.6.1` publica no slot global `Symbol.for('@agora/context:accessor')` um accessor cujos campos são funções (`packages/core/src/accessor.ts`): `{ traceId(), tenantId(), userRef(), get() }`. `packages/core/src/agora/context.ts` declarava `tenantId`/`userRef` como propriedades diretas, e `tenantFromContext()` lia `accessor?.tenantId` como VALOR — contra o accessor real, isso é a própria função. `typeof tenantId === 'string'` falha para uma função, então em produção `tenantFromContext()` sempre retornava `undefined` mesmo com um tenant ativo no contexto, e `resolveTenant: tenantFromContext` silenciosamente caía para o escopo global (`''`) em vez do tenant correto. Diferente do bug irmão do `adonis-agent` (que derrubava com 401 alto e visível), este falhava quieto — permissões com tenant-scope simplesmente não enxergavam o tenant certo, sem erro nenhum.

Isso passou despercebido porque `context.spec.ts` e `authz_integrations.spec.ts` montavam o dublê do accessor com `tenantId` como valor direto (`{ tenantId: 'acme' }`) — a forma que o código assumia, não a que `@adonis-agora/context` produz. `userRef` nunca chegou a ser lido por nenhum consumidor hoje (campo declarado na interface mas sem leitor), então não havia bug em produção nesse campo — só o tipo estava errado.

**O que muda:**

- `AgoraContextAccessor` (em `agora/context.ts`) agora tipa `traceId`/`tenantId`/`userRef` como métodos (`() => T | undefined`), espelhando o contrato real do accessor.
- `tenantFromContext()` passa a chamar `accessor.tenantId()` com segurança via um helper (`readMethod`) que tolera o campo não ser uma função (accessor parcial/mockado) e tolera o método lançar (fora de um contexto ativo) — em qualquer um dos dois casos degrada para `undefined` em vez de propagar.
- Nova função `userRefFromContext()`, com a mesma tolerância, agora exportada de `index.ts` para paridade com o accessor real (antes não existia leitor para esse campo).
- Specs de `agora/context.spec.ts` e `authz_integrations.spec.ts` reescritos para mockar o accessor na forma real (métodos), com casos novos cobrindo: método ausente, campo não-função, método que lança, e store sem o campo.

Não há mudança de assinatura pública além da nova função `userRefFromContext` (aditiva). `tenantFromContext`, `globalRolesFromContext`, `readContextValue` e `readContextAccessor` continuam com a mesma assinatura e mesmo comportamento fail-closed. Consumidores que hoje contornam este bug manualmente (lendo o accessor tolerando as duas formas, ou setando o tenant por outro caminho) podem remover o contorno depois de atualizar.
