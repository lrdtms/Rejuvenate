/**
 * useCurrentUser — wraps GET /api/v1/me with React Query.
 *
 * This is the single source of truth for "who is logged in" across the
 * entire admin area (RequireAuth, RoleGuard, AdminLayout, Dashboard all
 * read from this one cached query — never from a locally-duplicated copy).
 *
 * 401 handling:
 * - apiFetch throws ApiError on non-2xx, including 401.
 * - We catch 401 here and return null — this is the ONLY place in the app
 *   where a 401 is silently swallowed rather than surfaced as an error.
 * - Any other error is re-thrown so React Query can handle it normally.
 *
 * Config choices:
 * - staleTime: 0 — re-verify on every focus; auth state must never be stale
 * - retry: false — a 401 is not a transient network error worth retrying
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import type { CurrentUser } from '@/shared/types';

export const CURRENT_USER_QUERY_KEY = ['currentUser'] as const;

export function useCurrentUser(): {
  user: CurrentUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  const { data, isLoading } = useQuery<CurrentUser | null>({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: async () => {
      try {
        const res = await apiFetch<{ user: CurrentUser | null }>('/api/v1/me');
        return res.user;
      } catch (err) {
        // 401 means "not logged in" — not an error to surface
        if (isApiError(err) && err.status === 401) {
          return null;
        }
        // Any other error (network failure, 500, etc.) — re-throw
        throw err;
      }
    },
    staleTime: 0,
    retry: false,
  });

  const user = data ?? null;

  return {
    user,
    isLoading,
    isAuthenticated: user !== null,
  };
}
