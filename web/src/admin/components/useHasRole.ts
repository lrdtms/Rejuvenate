/**
 * useHasRole — inline conditional rendering helper.
 *
 * Returns true if the current user has any of the given roles.
 * Returns false when loading or unauthenticated.
 *
 * Usage:
 *   const canEdit = useHasRole('ADMIN', 'BLOGGER');
 *
 * Kept in its own file (separate from RoleGuard component) to satisfy
 * the react-refresh/only-export-components lint rule.
 */
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import type { AdminRole } from '@/admin/config/navConfig';

export function useHasRole(...roles: AdminRole[]): boolean {
  const { user } = useCurrentUser();
  if (!user) return false;
  return roles.includes(user.role as AdminRole);
}
