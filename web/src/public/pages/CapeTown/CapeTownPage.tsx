/**
 * CapeTownPage — ported from cape-town.html.
 *
 * Wired in Phase 6:
 * - Location contact card body driven by CmsSlot ('contact.capeTown.card')
 * - Upcoming events strip (up to 3) from the CAPE_TOWN branch via useEvents
 */
import { Link } from 'react-router-dom';
import { PageHero } from '@/design-system/PageHero';
import { Card } from '@/design-system/Card';
import { useCmsSlots } from '@/shared/hooks/useCmsSlots';
import { useEvents } from '@/shared/hooks/useEvents';
import { CmsSlot } from '@/shared/components/CmsSlot';
import { formatEventDateRange } from '@/shared/utils/formatDate';

export function CapeTownPage() {
  const { slots, isLoading: cmsLoading } = useCmsSlots(['contact.capeTown.card']);
  const {
    data: eventsData,
    isLoading: eventsLoading,
    error: eventsError,
  } = useEvents({ branch: 'CAPE_TOWN', temporal: 'upcoming', limit: 3 });

  return (
    <main className="inner-page">
      <PageHero
        variant="cape-town"
        title="Cape Town"
        subtitle="Gather with us in the Mother City."
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
              slotKey="contact.capeTown.card"
              slots={slots}
              fallback={
                <>
                  <p style={{ color: 'var(--muted)' }}>cape-town@rejuvenate.org</p>
                </>
              }
            />
          )}
        </Card>
      </section>
    </main>
  );
}
