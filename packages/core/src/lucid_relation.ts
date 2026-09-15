import { AUTHZ_TABLES, type AuthzTableNames } from './stores/lucid-schema.js';
import { GLOBAL_TENANT } from './user_ref.js';

/**
 * O mínimo do query builder de pivô do Lucid que este módulo usa. Estrutural para não
 * arrastar os tipos de relação do Lucid para a superfície pública por uma linha.
 */
interface PivotQueryLike {
  wherePivot(column: string, value: unknown): unknown;
  whereInPivot(column: string, values: readonly unknown[]): unknown;
  /** A instância `ManyToMany` dona desta query (todo builder de pivô do Lucid a expõe). */
  relation?: unknown;
}

/**
 * O que este módulo precisa da instância `ManyToMany` do Lucid. Tudo aqui é contrato
 * público (`ManyToManyRelationContract` + `pivotAlias`), lido DEPOIS do `boot()`.
 */
interface ManyToManyLike {
  model: { prototype: object; name: string };
  localKey: string;
  pivotForeignKey: string;
  pivotAlias(key: string): string;
  setRelated(parent: object, related: object[]): void;
  setRelatedForMany(parents: object[], related: object[]): void;
}

type RowLike = Record<string, unknown> & { $extras: Record<string, unknown> };

/** Marca a instância já normalizada — a relação é um singleton por modelo, patch uma vez. */
const NORMALIZED = Symbol.for('@adonis-agora/authz/normalized-relation');

/** O getter que expõe a chave do host como string, nomeado pela chave que espelha. */
const subjectKeyOf = (localKey: string) => `$authz_${localKey}`;

/**
 * Faz a relação casar o pivô com a chave do host SEM depender do tipo dela.
 *
 * O pivô do authz é polimórfico (`user_id` TEXT por default) e o Lucid usa o valor do
 * modelo tal-qual em dois lugares: no `WHERE user_id IN (...)` (SQLite não converte um
 * binding numérico para casar uma coluna TEXT — devolve nada) e na distribuição do
 * resultado (`pivot.user_id === parent[localKey]`, onde `'42' !== 42`). Um host
 * `increments()` via `preload('roles')` devolver `[]` SEM ERRO (#74). Pivôs INTEGER
 * têm o espelho: Postgres entrega `bigint` como string e `integer` como number.
 *
 * Os dois pontos são normalizados para STRING — a mesma comparação que o banco faz
 * numa coluna TEXT e que todo dialeto coerce numa coluna INTEGER:
 *
 * 1. `localKey` passa a apontar para um getter na prototype do modelo do host
 *    (`$authz_<chave>`) que devolve `String(chave)`. É só um acessor: não é `@column`,
 *    não entra em `$attributes`, hidratação, `serialize()` nem `save()` — o que mata
 *    o hijack do `id` da receita antiga (#84). `localKeyColumnName` fica intacto, então
 *    `has`/`whereHas` continuam a referenciar a coluna real.
 * 2. `setRelatedForMany` (o que o Preloader chama depois do `exec`) compara
 *    `String(pivot) === String(chave)`.
 *
 * Acontece na primeira query (o `onQuery` corre antes de `addWhereConstraints` e de
 * qualquer distribuição), na instância singleton que o modelo guarda. O tripwire em
 * `lucid_relation_models.spec.ts` prova que a distribuição original do Lucid ainda
 * precisa disto; quando o upstream (adonisjs/lucid#1197) coerçar, ele falha e este
 * bloco sai.
 */
function normalizeRelation(relation: unknown): void {
  if (!relation || typeof relation !== 'object' || NORMALIZED in relation) return;
  const rel = relation as ManyToManyLike;
  if (typeof rel.setRelatedForMany !== 'function' || typeof rel.pivotAlias !== 'function') return;

  const hostKey = rel.localKey;
  const subjectKey = subjectKeyOf(hostKey);
  if (!(subjectKey in rel.model.prototype)) {
    Object.defineProperty(rel.model.prototype, subjectKey, {
      configurable: true,
      get(this: Record<string, unknown>) {
        const value = this[hostKey];
        return value === undefined || value === null ? undefined : String(value);
      },
    });
  }
  rel.localKey = subjectKey;

  rel.setRelatedForMany = (parents, related) => {
    const alias = rel.pivotAlias(rel.pivotForeignKey);
    for (const parent of parents as RowLike[]) {
      const value = parent[subjectKey];
      const own =
        value === undefined
          ? []
          : (related as RowLike[]).filter((row) => {
              const pivotValue = row.$extras[alias];
              return (
                pivotValue !== undefined && pivotValue !== null && String(pivotValue) === value
              );
            });
      rel.setRelated(parent, own);
    }
  };
  Object.defineProperty(rel, NORMALIZED, { value: true });
}

/** Opções de {@link authzRolesRelation}. */
export interface AuthzRolesRelationOptions {
  /** Sobrescreve nomes de tabela, se o store foi configurado com outros. */
  tables?: AuthzTableNames;
  /**
   * O tipo de sujeito deste modelo — o `type` que `resolveUserRef` devolve para ele e
   * que `assignRole` gravou em `user_type`. Default `'user'`. Um modelo `Team` passa
   * `'team'`, um `ServiceAccount` `'service'`, etc.
   */
  subjectType?: string;
  /** @deprecated Use `subjectType` — mesmo significado, nome sem o "user" herdado. */
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
   * O atributo do modelo do host que o pivô referencia em `user_id`. Default: a chave
   * primária do próprio modelo (`Model.primaryKey`), seja ela `id`, `teamId` ou outra —
   * o tipo (integer, bigint, uuid) não importa, ver {@link authzRolesRelation}.
   * Só precisa disto quem liga o pivô a um atributo que NÃO é a PK.
   */
  localKey?: string;
}

/**
 * As opções de um `manyToMany` do Lucid ligando QUALQUER modelo do host aos papéis
 * do authz — users, teams, organizations: o que tiver uma chave primária.
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
 *   \@column({ isPrimary: true })
 *   declare id: number            // ou string (uuid), ou bigint — tanto faz
 *
 *   \@manyToMany(() => AuthzRole, authzRolesRelation())
 *   declare roles: ManyToMany<typeof AuthzRole>
 * }
 *
 * export default class Team extends BaseModel {
 *   \@column({ isPrimary: true, columnName: 'team_id' })
 *   declare teamId: number
 *
 *   \@manyToMany(() => AuthzRole, authzRolesRelation({ subjectType: 'team' }))
 *   declare roles: ManyToMany<typeof AuthzRole>
 * }
 * ```
 *
 * **O tipo da chave do host não importa.** O pivô grava `user_id` como TEXTO por
 * default (polimórfico: aceita integer e uuid na mesma tabela) e o Lucid distribui o
 * resultado do preload por igualdade ESTRITA — `'42'` (pivô) nunca casaria `42`
 * (modelo). Esta função normaliza o binding e a distribuição (ver `normalizeRelation`), então
 * `preload`/`load` funcionam com a PK como ela é: integer, bigint ou uuid, em pivôs
 * TEXT ou INTEGER (`subjectIdType`). Nada a declarar no modelo.
 *
 * Serve para LER. Escrita continua pelo store (`assignRole`/`removeRole`), que é quem
 * garante idempotência e a criação do papel quando ele ainda não existe.
 */
export function authzRolesRelation(options: AuthzRolesRelationOptions = {}) {
  const tables = { ...AUTHZ_TABLES, ...options.tables };
  const subjectType = options.subjectType ?? options.userType ?? 'user';
  const tenantId = options.tenantId ?? GLOBAL_TENANT;

  return {
    pivotTable: tables.userRole,
    // Sem `localKey` o Lucid usa a PK do modelo — o nome que o host escolheu.
    ...(options.localKey ? { localKey: options.localKey } : {}),
    pivotForeignKey: 'user_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'role_id',
    onQuery: (query: PivotQueryLike) => {
      // Roda antes de qualquer `exec`, logo antes de qualquer distribuição.
      normalizeRelation(query.relation);
      query.wherePivot('user_type', subjectType);
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
