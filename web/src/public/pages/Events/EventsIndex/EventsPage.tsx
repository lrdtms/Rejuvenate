/**
 * EventsPage — stub.
 * Will be wired to GET /api/v1/events in Phase 6 step 3.
 */
import { PageHero } from '@/design-system/PageHero';

export function EventsPage() {
  return (
    <main className="inner-page">
      <PageHero variant="location" title="Events" subtitle="Upcoming gatherings near you." />
      <section style={{ padding: '1rem 0' }}>
        <p style={{ color: 'var(--muted)' }}>Events are loading in Phase 6.</p>
      </section>
    </main>
  );
}
