---
'@adonis-agora/authz': minor
---

Novo `authzRolesRelation()`: as opções de um `manyToMany` do Lucid ligando o modelo de
usuário do host aos papéis do authz.

Sem isto, um app que queira ler papéis por RELAÇÃO (e não por chamada assíncrona por
usuário, que vira N+1 em listagem paginada) precisa redigitar os detalhes do pivô — e
eles são internos desta lib: o nome das colunas, o `user_type` (o authz é polimórfico,
então o tipo faz parte da chave) e o sentinel de tenant global, que é a string **vazia**
e não `null`.

Errar qualquer um deles não dá erro: dá uma relação que lê as linhas erradas em silêncio,
que é a pior forma de um bug de autorização.

```ts
@manyToMany(() => AuthzRole, authzRolesRelation())
declare roles: ManyToMany<typeof AuthzRole>
```

A lib deliberadamente NÃO define o modelo de papel: ele precisa da conexão do host, e
alguns apps querem a propriedade com outro nome (mapear a coluna `name` para `role`, para
não renomear consumidores existentes). O que é perigoso é o pivô, e é isso que a função
assume.
