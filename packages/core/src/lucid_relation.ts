import { AUTHZ_TABLES, type AuthzTableNames } from './stores/lucid-schema.js';
import { GLOBAL_TENANT } from './user_ref.js';

/**
 * O mínimo do query builder de pivô do Lucid que este módulo usa. Estrutural para não
 * arrastar os tipos de relação do Lucid para a superfície pública por uma linha.
 */
interface PivotQueryLike {
  wherePivot(column: string, value: unknown): unknown;
  whereInPivot(column: string, values: readonly unknown[]): unknown;
}

/** Opções de {@link authzRolesRelation}. */
export interface AuthzRolesRelationOptions {
  /** Sobrescreve nomes de tabela, se o store foi configurado com outros. */
  tables?: AuthzTableNames;
  /**
   * O `user_type` das linhas do pivô. Default `'user'` — o mesmo que
   * `refOf`/`assignRole` gravam para um usuário.
   */
  userType?: string;
  /**
   * O tenant a ler. Default o global (string vazia).
   *
   * Um tenant específico traz as linhas DELE **mais** as globais — a mesma
   * visibilidade que `getRolesForUser({ tenantId })` dá, porque um papel global vale
   * dentro de qualquer tenant. Só o pedido global é exclusivo (traz apenas globais).
   */
  tenantId?: string;
  /**
   * O atributo do modelo do host que guarda o id de usuário COMUM AO PIVÔ. Default `'id'`.
   *
   * O pivô é polimórfico e grava `user_id` como TEXTO (o authz aceita UUIDs). Quando o
   * `id` do host é `increments()` — número — o `whereIn` no SQL até casa (o banco coerce
   * `'42' = 42`), mas na volta o Lucid compara em JS `pivot.user_id` (`'42'`) com
   * `user.id` (`42`) em igualdade estrita: cada linha do pivô cai fora e `preload('roles')`
   * devolve `[]` SEM ERRO. Com ids numéricos passe um getter que exponha o id como
   * string (ver a receita no docblock de {@link authzRolesRelation}), ex.: `localKey: 'idAsText'`.
   *
   * NÃO duplique o `@column` sobre a mesma coluna (`@column({ columnName: 'id' })`
   * num segundo atributo): o Lucid mantém UM mapeamento de hidratação por coluna e o
   * segundo rouba o lugar — `idAsText` hidrata certo e o `id` do modelo vem `undefined`.
   */
  localKey?: string;
}

/**
 * As opções de um `manyToMany` do Lucid ligando o modelo de usuário do host aos papéis
 * do authz.
 *
 * Existe porque a alternativa é cada app redigitar os detalhes do pivô — e eles são
 * INTERNOS desta lib, não do app: o nome das colunas, o `user_type` (o authz é
 * polimórfico, então o tipo faz parte da chave) e o sentinel de tenant global, que é
 * a string VAZIA e não `null`. Errar qualquer um deles não dá erro: dá uma relação que
 * lê as linhas erradas em silêncio, que é a pior forma de um bug de autorização.
 *
 * A lib não define o MODELO de papel de propósito: ele precisa da conexão do host, e
 * alguns apps querem a propriedade com outro nome (mapear a coluna `name` para `role`,
 * por exemplo, para não renomear consumidores existentes). O que é perigoso é o pivô,
 * e é isso que esta função assume.
 *
 * ```ts
 * import { authzRolesRelation } from '@adonis-agora/authz'
 *
 * export default class User extends BaseModel {
 *   \@manyToMany(() => AuthzRole, authzRolesRelation())
 *   declare roles: ManyToMany<typeof AuthzRole>
 * }
 * ```
 *
 * **Ids numéricos (`increments()`)** — o `id` do pivô é texto; comparar `'42'` (pivô) com
 * `42` (modelo) em JS não casa e o `preload` devolve `[]` em silêncio. Aponte `localKey`
 * para um GETTER registrado com `@column` sobre a mesma coluna, **declarado antes do
 * `id`** — assim o `id` mantém o lugar de hidratação e o getter alimenta o
 * KeysExtractor da relação computando a partir do `id` já hidratado:
 *
 * ```ts
 * export default class User extends BaseModel {
 *   \@column({ columnName: 'id' })
 *   get idAsText(): string {
 *     return String(this.id)
 *   }
 *
 *   \@column({ isPrimary: true })
 *   declare id: number
 *
 *   \@manyToMany(() => AuthzRole, authzRolesRelation({ localKey: 'idAsText' }))
 *   declare roles: ManyToMany<typeof AuthzRole>
 * }
 * ```
 *
 * ⚠️ Um segundo `@column` PLANO (`declare idAsText` com `columnName: 'id'`) PARECE
 * funcionar — os papéis chegam — mas rouba o lugar de hidratação do `id`: o modelo
 * volta com `id: undefined`. É o tripwire de `lucid_relation_models.spec.ts` (#84).
 *
 * Serve para LER. Escrita continua pelo store (`assignRole`/`removeRole`), que é quem
 * garante idempotência e a criação do papel quando ele ainda não existe.
 */
export function authzRolesRelation(options: AuthzRolesRelationOptions = {}) {
  const tables = { ...AUTHZ_TABLES, ...options.tables };
  const userType = options.userType ?? 'user';
  const tenantId = options.tenantId ?? GLOBAL_TENANT;

  return {
    pivotTable: tables.userRole,
    localKey: options.localKey ?? 'id',
    pivotForeignKey: 'user_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'role_id',
    onQuery: (query: PivotQueryLike) => {
      query.wherePivot('user_type', userType);
      // Espelha o `tenantClause` do store: pedido global vê só o global; pedido de um
      // tenant vê o dele MAIS o global. Uma igualdade simples aqui descartaria os
      // papéis globais de quem lê por tenant — silenciosamente, que é exatamente o
      // modo de falha que esta função existe para remover.
      if (tenantId === GLOBAL_TENANT) {
        query.wherePivot('tenant_id', GLOBAL_TENANT);
      } else {
        query.whereInPivot('tenant_id', [GLOBAL_TENANT, tenantId]);
      }
    },
  };
}
