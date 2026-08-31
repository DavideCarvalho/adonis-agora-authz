import { createContext, createElement, type ReactNode } from 'react';

/** O valor do share de autorização que o `<AuthzProvider>`/`useAuthz` expõem. */
export interface AuthzContextValue {
  roles: string[];
  permissions: string[];
}

/**
 * Contexto opcional para fornecer o share de autorização fora do Inertia
 * (ex.: testes, Storybook, ou apps que não usam shared props). Quando
 * ausente (default), `useAuthz()`/`useCan()` leem de
 * `usePage().props.authz` (ver `./use_authz.ts`).
 */
export const AuthzContext = createContext<AuthzContextValue | undefined>(undefined);

export interface AuthzProviderProps {
  value: AuthzContextValue;
  children: ReactNode;
}

/**
 * Provider opcional. Útil quando o host quer injetar o share de autorização
 * manualmente em vez de depender das shared props do Inertia (ex.: testes
 * unitários de componentes que usam `<Can>`/`useCan`/`useAuthz`).
 */
export function AuthzProvider({ value, children }: AuthzProviderProps) {
  return createElement(AuthzContext.Provider, { value }, children);
}
