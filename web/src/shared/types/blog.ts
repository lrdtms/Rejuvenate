/**
 * BlogPost — shape returned by GET /api/v1/blog/posts and
 * GET /api/v1/blog/posts/:slug.
 *
 * body is sanitized HTML (server-side) — safe to render via
 * dangerouslySetInnerHTML; do not re-sanitize client-side.
 */
export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  status: string;
  publishedAt: string | null;
  author: {
    id: string;
    email: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface BlogPostsPage {
  items: BlogPost[];
  page: number;
  limit: number;
  total: number;
  pageCount: number;
}
