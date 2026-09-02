import { describe, expect, it } from 'vitest';
import { authzRolesRelation } from './lucid_relation.js';

/** Captura as chamadas de `wherePivot` que o `onQuery` faria. */
function capture(relation: ReturnType<typeof authzRolesRelation>) {
  const calls: Array<[string, unknown]> = [];
  relation.onQuery({
    wherePivot: (c: string, v: unknown) => void calls.push([c, v]),
    whereInPivot: (c: string, v: readonly unknown[]) => void calls.push([c, v]),
  });
  return calls;
}

/**
 * Os detalhes do pivô são internos DESTA lib, não do app: nome das colunas, o
 * `user_type` (o authz é polimórfico, então o tipo faz parte da chave) e o sentinel de
 * tenant global — que é a string VAZIA, não `null`.
 *
 * Errar qualquer um não dá erro: dá uma relação que lê as linhas erradas em silêncio.
 * É por isso que estes testes existem, e por isso a função existe.
 */
describe('authzRolesRelation', () => {
  it('aponta para as tabelas e colunas do store', () => {
    const relation = authzRolesRelation();
    expect(relation.pivotTable).toBe('authz_user_role');
    expect(relation.pivotForeignKey).toBe('user_id');
    expect(relation.pivotRelatedForeignKey).toBe('role_id');
  });

  it('filtra o pivô por user_type E por tenant', () => {
    expect(capture(authzRolesRelation())).toEqual([
      ['user_type', 'user'],
      ['tenant_id', ''],
    ]);
  });

  it('o tenant global é string VAZIA, não null', () => {
    // Um `null` aqui não casaria linha nenhuma: o store grava '' (GLOBAL_TENANT).
    const [, tenant] = capture(authzRolesRelation());
    expect(tenant?.[1]).toBe('');
    expect(tenant?.[1]).not.toBeNull();
  });

  it('respeita nomes de tabela customizados', () => {
    const relation = authzRolesRelation({ tables: { userRole: 'rbac_user_role' } });
    expect(relation.pivotTable).toBe('rbac_user_role');
  });

  it('permite outro user_type', () => {
    const calls = capture(authzRolesRelation({ userType: 'service' }));
    expect(calls[0]).toEqual(['user_type', 'service']);
  });

  it('um tenant específico vê o dele MAIS o global', () => {
    // Espelha o `tenantClause` do store: um papel global vale dentro de qualquer
    // tenant. Uma igualdade simples aqui descartaria os globais em silêncio — o
    // próprio modo de falha que esta função existe para remover.
    const calls = capture(authzRolesRelation({ tenantId: 'acme' }));
    expect(calls[1]).toEqual(['tenant_id', ['', 'acme']]);
  });

  it('o pedido global é exclusivo — só linhas globais', () => {
    expect(capture(authzRolesRelation())[1]).toEqual(['tenant_id', '']);
  });
});
