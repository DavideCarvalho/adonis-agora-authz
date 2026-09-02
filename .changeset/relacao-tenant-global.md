---
'@adonis-agora/authz': patch
---

`authzRolesRelation({ tenantId })` descartava os papéis globais.

O `tenantClause` do store devolve, para um tenant específico, as linhas dele **mais** as
globais — um papel global vale dentro de qualquer tenant. A relação aplicava uma
igualdade simples no `tenant_id`, então `authzRolesRelation({ tenantId: 'acme' })` trazia
só as de `acme`, e um papel atribuído globalmente sumia.

Silenciosamente — que é exatamente o modo de falha que a função foi escrita para remover.

O caminho default (tenant global) sempre esteve correto, então quem não usa a opção não é
afetado. Agora a relação espelha o store: pedido global vê só o global; pedido de tenant
vê o dele mais o global.
