/**
 * DurbanPage — ported from durban.html.
 *
 * Wired in Phase 6:
 * - Location contact card body driven by CmsSlot ('contact.durban.card')
 * - Upcoming events strip (up to 3) from the DURBAN branch via useEvents
 */
import { Link } from 'react-router-dom';
import { PageHero } from '@/design-system/PageHero';
import { Card } from '@/design-system/Card';
import { useCmsSlots } from '@/shared/hooks/useCmsSlots';
import { useEvents } from '@/shared/hooks/useEvents';
import { CmsSlot } from '@/shared/components/CmsSlot';
import { formatEventDateRange } from '@/shared/utils/formatDate';

export function DurbanPage() {
  const { slots, isLoading: cmsLoading } = useCmsSlots(['contact.durban.card']);
  const {
    data: eventsData,
    isLoading: eventsLoading,
    error: eventsError,
  } = useEvents({ branch: 'DURBAN', temporal: 'upcoming', limit: 3 });

  return (
    <main className="inner-page">
      <PageHero
        variant="durban"
        title="Durban"
        subtitle="Worship, community, and renewal on the coast."
      />

      <section className="content-grid location-content-grid">
        {/* Upcoming events strip — minimal list, links to /events/:slug */}
        <Card>
          <h2>Upcoming Events</h2>
          {eventsLoading && (
            <div className="loading-placeholder" aria-busy="true" />
          )}
          {eventsError && (
            <p style={{ color: 'var(--muted)' }}>
              Could not load events.{' '}
              <Link to="/events">View all events</Link>
            </p>
          )}
          {!eventsLoading && !eventsError && eventsData && (
            eventsData.items.length > 0 ? (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {eventsData.items.map((event) => (
                  <li key={event.id} style={{ marginBottom: '0.75rem' }}>
                    <Link
                      to={`/events/${event.slug}`}
                      style={{ color: 'var(--accent)', fontWeight: 700 }}
                    >
                      {event.title}
                    </Link>
                    <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.9rem' }}>
                      {formatEventDateRange(event.startsAt, event.endsAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: 'var(--muted)' }}>
                No upcoming events.{' '}
                <Link to="/events">View all events</Link>
              </p>
            )
          )}
          {!eventsLoading && !eventsError && !eventsData && (
            <p style={{ color: 'var(--muted)' }}>
              See our <Link to="/events">Events page</Link> for upcoming gatherings.
            </p>
          )}
        </Card>

        {/* Location contact card — body driven by CMS */}
        <Card variant="location-contact">
          <h2>Local Contact</h2>
          {cmsLoading ? (
            <div className="loading-placeholder" aria-busy="true" />
          ) : (
            <CmsSlot
              slotKey="contact.durban.card"
              slots={slots}
              fallback={
                <>
                  <p style={{ color: 'var(--muted)' }}>durban@rejuvenate.org</p>
                </>
              }
            />
          )}
        </Card>
      </section>
    </main>
  );
}
