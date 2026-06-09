/**
 * BlogPostPage — single blog post detail view.
 * Wired to GET /api/v1/blog/posts/:slug (Phase 6 step 2).
 *
 * 404 (including scheduled-but-not-yet-live posts) renders NotFoundPage inline.
 * body is sanitized server-side — rendered via dangerouslySetInnerHTML.
 */
import { useParams, Link } from 'react-router-dom';
import { useBlogPost } from '@/shared/hooks/useBlogPost';
import { NotFoundPage } from '@/public/pages/NotFound/NotFoundPage';
import { formatDateTime } from '@/shared/utils/formatDate';

export function BlogPostPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const { data, isLoading, error } = useBlogPost(slug);

  if (isLoading) {
    return (
      <main className="inner-page">
        <div
          className="loading-placeholder"
          style={{ height: '2.5rem', width: '20rem', marginBottom: '1rem' }}
          aria-busy="true"
        />
        <div className="loading-placeholder" style={{ height: '1rem', width: '12rem' }} aria-busy="true" />
      </main>
    );
  }

  if (error) {
    return (
      <main className="inner-page">
        <p style={{ color: 'var(--muted)' }}>Something went wrong — please try again.</p>
      </main>
    );
  }

  // data === null means 404 (useBlogPost swallows 404 and returns null)
  if (data === null) {
    return <NotFoundPage />;
  }

  // Still loading (data undefined — before query resolves)
  if (data === undefined) {
    return null;
  }

  return (
    <main className="inner-page">
      <article>
        <header className="blog-post-header">
          <h1>{data.title}</h1>
          <p className="blog-post-meta">
            {formatDateTime(data.publishedAt)}
            {data.author?.email ? ` · ${data.author.email}` : ''}
          </p>
        </header>

        {/* body is sanitized server-side; do not re-sanitize client-side */}
        <div
          className="blog-post-body rich-text"
          dangerouslySetInnerHTML={{ __html: data.body }}
        />

        <p style={{ marginTop: '2rem' }}>
          <Link to="/blog" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            &larr; Back to Blog
          </Link>
        </p>
      </article>
    </main>
  );
}
