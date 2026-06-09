/**
 * BlogListPage — stub.
 * Will be wired to GET /api/v1/blog/posts in Phase 6 step 2.
 */
import { PageHero } from '@/design-system/PageHero';

export function BlogListPage() {
  return (
    <main className="inner-page">
      <PageHero variant="about" title="Blog" subtitle="Thoughts, updates, and reflections." />
      <section style={{ padding: '1rem 0' }}>
        <p style={{ color: 'var(--muted)' }}>Posts are loading in Phase 6.</p>
      </section>
    </main>
  );
}
