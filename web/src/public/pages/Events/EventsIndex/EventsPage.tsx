/**
 * EventsPage — paginated list of events with branch filter and
 * upcoming/past toggle.
 * Wired to GET /api/v1/events (Phase 6 step 3).
 *
 * Filter state is stored in URL query params (branch, temporal, page)
 * so browser back/forward works.
 */
import { useSearchParams, Link } from 'react-router-dom';
import { PageHero } from '@/design-system/PageHero';
import { useEvents } from '@/shared/hooks/useEvents';
import type { UseEventsParams } from '@/shared/hooks/useEvents';
import { formatEventDateRange } from '@/shared/utils/formatDate';

const PAGE_SIZE = 10;

type BranchFilter = 'ALL' | 'CAPE_TOWN' | 'DURBAN';
type TemporalFilter = 'upcoming' | 'past' | 'all';

export function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branch = (searchParams.get('branch') as BranchFilter) ?? 'ALL';
  const temporal = (searchParams.get('temporal') as TemporalFilter) ?? 'upcoming';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1'));

  const queryParams: UseEventsParams = {
    page,
    limit: PAGE_SIZE,
    temporal,
  };
  if (branch !== 'ALL') {
    queryParams.branch = branch as 'CAPE_TOWN' | 'DURBAN';
  }

  const { data, isLoading, error } = useEvents(queryParams);

  function updateFilter(updates: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, val] of Object.entries(updates)) {
      next.set(key, val);
    }
    // Reset to page 1 on filter change
    if (!('page' in updates)) {
      next.set('page', '1');
    }
    setSearchParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <main className="inner-page">
      <PageHero variant="location" title="Events" subtitle="Upcoming gatherings near you." />

      <section style={{ paddingTop: '1.5rem' }}>
        {/* Filter bar */}
        <div className="events-filter-bar" role="group" aria-label="Filter events">
          {/* Branch filter */}
          {(
            [
              { value: 'ALL', label: 'All Branches' },
              { value: 'CAPE_TOWN', label: 'Cape Town' },
              { value: 'DURBAN', label: 'Durban' },
            ] as { value: BranchFilter; label: string }[]
          ).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`events-filter-btn${branch === value ? ' active' : ''}`}
              aria-pressed={branch === value}
              onClick={() => updateFilter({ branch: value })}
            >
              {label}
            </button>
          ))}

          <span style={{ color: 'var(--line)', margin: '0 0.25rem' }}>|</span>

          {/* Temporal filter */}
          {(
            [
              { value: 'upcoming', label: 'Upcoming' },
              { value: 'past', label: 'Past' },
              { value: 'all', label: 'All' },
            ] as { value: TemporalFilter; label: string }[]
          ).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`events-filter-btn${temporal === value ? ' active' : ''}`}
              aria-pressed={temporal === value}
              onClick={() => updateFilter({ temporal: value })}
            >
              {label}
            </button>
          ))}
        </div>

        {isLoading && (
          <div className="loading-placeholder" style={{ height: '2rem', width: '14rem' }} aria-busy="true" />
        )}

        {error && (
          <p style={{ color: 'var(--muted)' }}>Something went wrong — please try again.</p>
        )}

        {!isLoading && !error && data && (
          <>
            {data.items.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                {temporal === 'upcoming' ? 'No upcoming events.' : 'No events found.'}
              </p>
            ) : (
              <ol className="event-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {data.items.map((event) => (
                  <li key={event.id} className="event-list-item">
                    <h3>
                      <Link to={`/events/${event.slug}`}>{event.title}</Link>
                    </h3>
                    <p className="event-list-item-meta">
                      {event.branch === 'CAPE_TOWN' ? 'Cape Town' : 'Durban'}
                      {' · '}
                      {formatEventDateRange(event.startsAt, event.endsAt)}
                      {event.capacity != null ? ` · Capacity: ${event.capacity}` : ''}
                    </p>
                    {event.description && (
                      <p className="event-list-item-description">
                        {event.description.length > 160
                          ? `${event.description.slice(0, 160)}…`
                          : event.description}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {data.pageCount > 1 && (
              <nav className="pagination" aria-label="Events pagination">
                <button
                  type="button"
                  onClick={() => updateFilter({ page: String(page - 1) })}
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
                  onClick={() => updateFilter({ page: String(page + 1) })}
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
