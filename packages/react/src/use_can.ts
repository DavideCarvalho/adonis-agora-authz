import { satisfiesShared } from './matcher.js';
import { useAuthz } from './use_authz.js';

/**
 * Gateia em uma permissão do share de autorização (wildcard-aware — ver
 * `./matcher.ts`). Fail-closed: sem share (deslogado / fora de contexto),
 * devolve `false`.
 */
export function useCan(permission: string): boolean {
  const { permissions } = useAuthz();
  return satisfiesShared(permissions, permission);
}
