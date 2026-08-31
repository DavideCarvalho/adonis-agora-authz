import { usePage } from '@inertiajs/react';
import { useContext } from 'react';
import { AuthzContext, type AuthzContextValue } from './provider.js';
import type { AuthzSharedProps } from './types.js';

const EMPTY_SHARE: AuthzContextValue = { roles: [], permissions: [] };

/**
 * Lê o share de autorização: o valor do `<AuthzProvider>` tem precedência
 * sobre a shared-prop do Inertia (`usePage().props.authz`, montada no
 * servidor por `buildAuthzShare`). Sem nenhum dos dois, devolve o share
 * vazio (fail-closed: nenhuma role/permission).
 *
 * `usePage()` lança fora de um `<App>` Inertia — capturamos para manter
 * `useAuthz`/`useCan`/`<Can>` testáveis com apenas um `<AuthzProvider>`,
 * sem montar toda a árvore do Inertia (mesmo padrão de
 * `@adonis-agora/authkit-react`'s `usePrincipalId`).
 */
export function useAuthz(): AuthzContextValue {
  const fromContext = useContext(AuthzContext);
  let fromPage: AuthzSharedProps['authz'] | undefined;
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: the call is unconditional and always in the same order — the try only absorbs the throw `usePage()` makes outside an Inertia `<App>` (see the doc above).
    fromPage = usePage<AuthzSharedProps>().props?.authz;
  } catch {
    fromPage = undefined;
  }
  return fromContext ?? fromPage ?? EMPTY_SHARE;
}
