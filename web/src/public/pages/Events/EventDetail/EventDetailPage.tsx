/**
 * EventDetailPage — single event detail view with RSVP form.
 * Wired to GET /api/v1/events/:slug (Phase 6 step 3).
 *
 * 404 renders NotFoundPage inline.
 * RsvpForm is shown only if startsAt > now() (event hasn't started yet).
 * isPaid / priceCents are deliberately not rendered (dormant, ADR-0006).
 */
import { useParams } from 'react-router-dom';
import { useEvent } from '@/shared/hooks/useEvent';
import { NotFoundPage } from '@/public/pages/NotFound/NotFoundPage';
import { RsvpForm } from '../RsvpForm/RsvpForm';
import { formatEventDateRange } from '@/shared/utils/formatDate';

export function EventDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const { data, isLoading, error } = useEvent(slug);

  if (isLoading) {
    return (
      <main className="inner-page">
        <div
          className="loading-placeholder"
          style={{ height: '2.5rem', width: '22rem', marginBottom: '1rem' }}
          aria-busy="true"
        />
        <div className="loading-placeholder" style={{ height: '1rem', width: '14rem' }} aria-busy="true" />
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

  if (data === null) {
    return <NotFoundPage />;
  }

  if (data === undefined) {
    return null;
  }

  const hasStarted = new Date(data.startsAt) <= new Date();

  return (
    <main className="inner-page">
      <article>
        <header className="event-detail-header">
          <h1>{data.title}</h1>
          <p className="event-detail-meta">
            {data.branch === 'CAPE_TOWN' ? 'Cape Town' : 'Durban'}
            {' · '}
            {formatEventDateRange(data.startsAt, data.endsAt)}
            {data.capacity != null ? ` · Capacity: ${data.capacity}` : ''}
          </p>
        </header>

        {data.description && (
          <p className="event-detail-description">{data.description}</p>
        )}

        {/* RSVP / registration section */}
        {hasStarted ? (
          <p style={{ color: 'var(--muted)', marginTop: '2rem' }}>
            Registration for this event is closed.
          </p>
        ) : (
          <RsvpForm slug={slug} eventTitle={data.title} />
        )}
      </article>
    </main>
  );
}
