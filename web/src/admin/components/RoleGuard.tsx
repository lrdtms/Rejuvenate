/**
 * RoleGuard — two forms:
 *
 * 1. Component form — wraps a subtree:
 *    <RoleGuard allow={['ADMIN', 'BLOGGER']}>
 *      <SomePage />
 *    </RoleGuard>
 *    Renders children if the current user's role is in `allow`.
 *    Otherwise redirects to /admin (Dashboard) and sets an access-denied message.
 *
 * 2. Hook form — for inline conditional rendering:
 *    const canEdit = useHasRole('ADMIN', 'BLOGGER');
 *    Returns true if the current user's role is any of the given roles.
 *
 * Both forms are UX-only — the server independently re-checks every request.
 * The role matrix lives in adminNavConfig, not scattered here.
 */
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import { useAccessDenied } from './AccessDeniedContext';
import type { AdminRole } from '@/admin/config/navConfig';

interface RoleGuardProps {
  allow: AdminRole[];
  children: ReactNode;
}

export function RoleGuard({ allow, children }: RoleGuardProps) {
  const { user } = useCurrentUser();
  const { setMessage } = useAccessDenied();

  // User must be present here (RequireAuth already checked isAuthenticated).
  // If somehow null, redirect to login.
  if (!user) {
    return <Navigate to="/admin/login" replace />;
  }

  if (!allow.includes(user.role as AdminRole)) {
    // Set the notice for Dashboard to display; redirect there.
    setMessage("You don't have access to that.");
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
}

/**
 * useHasRole — inline conditional rendering helper.
 * Returns true if the current user has any of the given roles.
 * Returns false when loading or unauthenticated.
 */
export function useHasRole(...roles: AdminRole[]): boolean {
  const { user } = useCurrentUser();
  if (!user) return false;
  return roles.includes(user.role as AdminRole);
}
