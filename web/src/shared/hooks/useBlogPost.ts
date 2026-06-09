/**
 * useBlogPost — fetches a single blog post by slug.
 * Wraps GET /api/v1/blog/posts/:slug.
 *
 * 404s are treated as null data (not thrown errors) so pages can
 * render <NotFoundPage /> inline rather than hitting the error boundary.
 * A scheduled-but-not-yet-live post also 404s from the backend — same
 * treatment (normal not-found, no "coming soon" state).
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import type { BlogPost } from '@/shared/types';

export function useBlogPost(slug: string) {
  return useQuery<BlogPost | null>({
    queryKey: ['blog', 'post', slug],
    queryFn: async () => {
      try {
        const res = await apiFetch<{ post: BlogPost }>(`/api/v1/blog/posts/${encodeURIComponent(slug)}`);
        return res.post;
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
