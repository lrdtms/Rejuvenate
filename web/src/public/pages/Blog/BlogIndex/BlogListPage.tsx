/**
 * BlogListPage — paginated list of published blog posts.
 * Wired to GET /api/v1/blog/posts?page=N&limit=N (Phase 6 step 2).
 *
 * Pagination uses the `page` URL query param so browser back/forward works.
 */
import { useSearchParams, Link } from 'react-router-dom';
import { PageHero } from '@/design-system/PageHero';
import { useBlogPosts } from '@/shared/hooks/useBlogPosts';
import { formatDateTime } from '@/shared/utils/formatDate';

const PAGE_SIZE = 10;

export function BlogListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number(searchParams.get('page') ?? '1'));

  const { data, isLoading, error } = useBlogPosts({ page, limit: PAGE_SIZE });

  function goToPage(next: number) {
    setSearchParams({ page: String(next) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <main className="inner-page">
      <PageHero variant="about" title="Blog" subtitle="Thoughts, updates, and reflections." />

      <section style={{ paddingTop: '1.5rem' }}>
        {isLoading && (
          <div className="loading-placeholder" style={{ height: '2rem', width: '14rem' }} aria-busy="true" />
        )}

        {error && (
          <p style={{ color: 'var(--muted)' }}>Something went wrong — please try again.</p>
        )}

        {!isLoading && !error && data && (
          <>
            {data.items.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No posts yet — check back soon.</p>
            ) : (
              <ol className="blog-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {data.items.map((post) => (
                  <li key={post.id} className="blog-list-item">
                    <h2>
                      <Link to={`/blog/${post.slug}`}>{post.title}</Link>
                    </h2>
                    <p className="blog-list-item-meta">
                      {formatDateTime(post.publishedAt)}
                      {post.author?.email ? ` · ${post.author.email}` : ''}
                    </p>
                    {post.excerpt && (
                      <p className="blog-list-item-excerpt">{post.excerpt}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {data.pageCount > 1 && (
              <nav className="pagination" aria-label="Blog pagination">
                <button
                  type="button"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1}
                  aria-label="Previous page"
                >
                  &larr; Prev
                </button>
                <span>
                  Page {page} of {data.pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= data.pageCount}
                  aria-label="Next page"
                >
                  Next &rarr;
                </button>
              </nav>
            )}
          </>
        )}
      </section>
    </main>
  );
}
