import { createElement, Fragment, type ReactNode } from 'react';
import { permissionSatisfied } from '../matcher.js';
import { useAuthz } from '../use_authz.js';

export interface CanProps {
  children: ReactNode;
  /** permissão a verificar (wildcard-aware — ver `../matcher.ts`) */
  permission?: string;
  /** role a verificar (comparação exata contra `roles`) */
  role?: string;
  /** renderizado quando o usuário não satisfaz `permission`/`role` */
  fallback?: ReactNode;
}

/**
 * Renderiza `children` somente se o usuário satisfizer `permission` (via
 * `permissionSatisfied`, wildcard-aware) ou possuir `role` (comparação
 * exata), caso contrário renderiza `fallback`. Fail-closed: sem
 * `permission`/`role` informados, ou sem share de autorização disponível,
 * não renderiza `children`.
 *
 * - `<Can permission="posts.edit">…</Can>`
 * - `<Can role="admin">…</Can>`
 * - `<Can permission="posts.edit" fallback={<Denied />}>…</Can>`
 */
export function Can({ children, permission, role, fallback = null }: CanProps) {
  const { roles, permissions } = useAuthz();
  let allowed = false;
  if (permission !== undefined) allowed = permissionSatisfied(permissions, permission);
  else if (role !== undefined) allowed = roles.includes(role);
  return createElement(Fragment, null, allowed ? children : fallback);
}
