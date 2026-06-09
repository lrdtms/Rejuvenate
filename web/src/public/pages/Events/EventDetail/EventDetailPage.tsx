/**
 * EventDetailPage — stub.
 * Will be wired to GET /api/v1/events/:slug in Phase 6 step 3.
 */
import { useParams } from 'react-router-dom';

export function EventDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <main className="inner-page">
      <h1 style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Event Detail</h1>
      <p style={{ color: 'var(--muted)' }}>Slug: {slug} — wired to live data in Phase 6.</p>
    </main>
  );
}
