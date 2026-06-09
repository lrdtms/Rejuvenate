/**
 * RoleGuard — component form for role-based access control.
 *
 * Usage:
 *   <RoleGuard allow={['ADMIN', 'BLOGGER']}>
 *     <SomePage />
 *   </RoleGuard>
 *
 * Renders children if the current user's role is in `allow`.
 * Otherwise redirects to /admin (Dashboard) and sets an access-denied message.
 *
 * UX-only — the server independently re-checks every request.
 * The role matrix lives in adminNavConfig, not scattered here.
 *
 * See also: useHasRole (useHasRole.ts) for inline conditional rendering.
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
