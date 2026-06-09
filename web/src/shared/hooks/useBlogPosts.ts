/**
 * useBlogPosts — fetches a paginated list of published blog posts.
 * Wraps GET /api/v1/blog/posts?page=N&limit=N.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/shared/api/client';
import type { BlogPostsPage } from '@/shared/types';

export interface UseBlogPostsParams {
  page?: number;
  limit?: number;
}

export function useBlogPosts({ page = 1, limit = 20 }: UseBlogPostsParams = {}) {
  return useQuery<BlogPostsPage>({
    queryKey: ['blog', 'posts', { page, limit }],
    queryFn: () =>
      apiFetch<BlogPostsPage>(`/api/v1/blog/posts?page=${page}&limit=${limit}`),
  });
}
