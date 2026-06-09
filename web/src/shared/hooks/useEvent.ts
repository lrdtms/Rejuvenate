/**
 * useEvent — fetches a single event by slug.
 * Wraps GET /api/v1/events/:slug.
 *
 * 404s are treated as null data so pages can render <NotFoundPage />
 * inline rather than hitting the error boundary.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import type { Event } from '@/shared/types';

export function useEvent(slug: string) {
  return useQuery<Event | null>({
    queryKey: ['events', 'detail', slug],
    queryFn: async () => {
      try {
        return await apiFetch<Event>(`/api/v1/events/${encodeURIComponent(slug)}`);
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    enabled: !!slug,
  });
}
