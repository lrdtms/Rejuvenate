/**
 * useCmsSlots — batch-fetches CMS slot values for a set of slot keys.
 *
 * Issues a single GET /api/v1/cms?keys=<keys.join(',')> request and
 * returns the map directly, keyed by slotKey. Every requested key is
 * guaranteed present in the response (backend contract: safe empty
 * value: '' for unpopulated slots — never an omitted key).
 *
 * staleTime is set to 30 min because CMS content changes rarely and
 * the backend plans response-level caching at the same granularity.
 *
 * This hook is intentionally "dumb" — it is shared unchanged between
 * public pages and the admin SlotEditor preview pane (Phase 8),
 * which is what makes WYSIWYG fidelity (architecture.md §9.5)
 * structural rather than aspirational.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import type { CmsSlotView } from '@/shared/types';

export function useCmsSlots(keys: string[]): {
  slots: Record<string, CmsSlotView> | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const joined = keys.slice().sort().join(',');

  const { data, isLoading, error } = useQuery<Record<string, CmsSlotView>>({
    queryKey: ['cms', joined],
    queryFn: () => apiFetch<Record<string, CmsSlotView>>(`/api/v1/cms?keys=${encodeURIComponent(joined)}`),
    staleTime: 30 * 60 * 1000, // 30 minutes — CMS content changes rarely
    enabled: keys.length > 0,
  });

  return {
    slots: data,
    isLoading,
    error: isApiError(error) ? error : error,
  };
}
