// Client-safe barrel. Deliberately excludes `./share.js` (server, imports
// `@adonis-agora/authz`'s `AuthzService`) — that ships under the separate
// `@adonis-agora/authz-react/server` subpath so it never lands in the client
// bundle. See `./share.ts`.

export type { CanProps } from './components/can.js';
// Componente de gating.
export { Can } from './components/can.js';
// Wildcard matcher — client-safe port of the core's `permission_matcher.ts`.
export { permissionMatches, permissionSatisfied } from './matcher.js';
export type { AuthzContextValue, AuthzProviderProps } from './provider.js';
// Contexto opcional.
export { AuthzContext, AuthzProvider } from './provider.js';
// Tipos da shared-prop do Inertia.
export type { AuthzSharedProps } from './types.js';
// Hooks.
export { useAuthz } from './use_authz.js';
export { useCan } from './use_can.js';
