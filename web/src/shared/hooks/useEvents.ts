/**
 * useEvents — fetches a paginated, filterable list of events.
 * Wraps GET /api/v1/events?page=N&limit=N&branch=X&temporal=Y.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/shared/api/client';
import type { EventsPage } from '@/shared/types';

export interface UseEventsParams {
  page?: number;
  limit?: number;
  branch?: 'CAPE_TOWN' | 'DURBAN';
  temporal?: 'upcoming' | 'past' | 'all';
}

export function useEvents({
  page = 1,
  limit = 20,
  branch,
  temporal,
}: UseEventsParams = {}) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (branch) params.set('branch', branch);
  if (temporal) params.set('temporal', temporal);

  return useQuery<EventsPage>({
    queryKey: ['events', { page, limit, branch, temporal }],
    queryFn: () => apiFetch<EventsPage>(`/api/v1/events?${params.toString()}`),
  });
}
