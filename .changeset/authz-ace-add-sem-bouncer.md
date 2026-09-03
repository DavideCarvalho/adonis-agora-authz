---
'@adonis-agora/authz': patch
---

`node ace add @adonis-agora/authz` quebrava logo depois de instalar, com
`Cannot find module "@adonis-agora/authz"` seguido de
`Unable to configure @adonis-agora/authz` — mesmo com o pacote instalado.
(`node ace configure` direto falhava do mesmo jeito.) Eram dois defeitos
combinados, ambos invisíveis no monorepo porque as devDependencies instalam
todos os peers:

1. O entry principal (`src/index.ts`) não re-exportava o `configure`, e o Adonis
   descobre o hook importando o MAIN do pacote e lendo `configure` do namespace
   — o subpath `./configure` sozinho nunca é consultado. Sem o re-export, o
   `configure` jamais rodava (provider, comandos e stubs não eram publicados).
2. O entry principal importava estaticamente o peer OPCIONAL `@adonisjs/bouncer`
   (via `./bouncer/abilities.js`). Num app sem bouncer, o próprio `import` do
   pacote lançava `ERR_MODULE_NOT_FOUND` — que o `ace configure` reportava errado
   como se o `@adonis-agora/authz` não estivesse instalado.

Agora o `index.ts` re-exporta o `configure` (mesma convenção do
telescope/durable), e o `bouncer/abilities.ts` pré-carrega o bouncer com um
top-level await que tolera a ausência dele: o pacote importa normalmente sem o
peer, e só quem CHAMA `defineAuthzAbilities()`/`authzAbilities()` sem o bouncer
instalado recebe um erro acionável (`Run node ace add @adonisjs/bouncer`).

Sem breaking change: as duas funções continuam síncrona/assíncrona como antes e
nos mesmos caminhos de import (`@adonis-agora/authz`, stub e docs inalterados).
