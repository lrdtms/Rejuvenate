/**
 * RegistrationsView — attendee list for a specific event.
 *
 * POPIA note: shows logistics fields only (name, age, email, phone, registeredAt).
 * No decorative data — what Event Managers need for logistics per plan.md spec.
 *
 * CSV download: hidden <a> tag clicked programmatically — the browser handles
 * the download natively with credentials (cookies), no fetch + blob needed.
 */
import { useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { Button } from '@/design-system/Button';
import { formatDateTime } from '@/shared/utils/formatDate';
import type { AdminEvent, RegistrationsPage } from '@/shared/types';
import '@/admin/admin.css';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
const PAGE_LIMIT = 50;

export function RegistrationsView() {
  const { id } = useParams<{ id: string }>();
  const csvLinkRef = useRef<HTMLAnchorElement>(null);

  const { data: event, isLoading: eventLoading } = useQuery<AdminEvent>({
    queryKey: ['adminEvent', id],
    queryFn: () => apiFetch<AdminEvent>(`/api/v1/admin/events/${id}`),
    enabled: !!id,
  });

  const { data, isLoading, isError, error } = useQuery<RegistrationsPage>({
    queryKey: ['adminRegistrations', id],
    queryFn: () =>
      apiFetch<RegistrationsPage>(
        `/api/v1/admin/events/${id}/registrations?limit=${PAGE_LIMIT}`
      ),
    enabled: !!id,
  });

  function downloadCsv() {
    if (csvLinkRef.current) {
      csvLinkRef.current.click();
    }
  }

  if (eventLoading || isLoading) {
    return <div className="admin-state">Loading registrations…</div>;
  }

  const capacityText =
    event && event.capacity != null
      ? `${data?.total ?? 0} / ${event.capacity} registered`
      : `${data?.total ?? 0} registered — no capacity limit`;

  return (
    <div>
      <div className="admin-page-header">
        <div className="registrations-header">
          <h1 className="admin-page-title">
            Registrations
            {event ? ` — ${event.title}` : ''}
          </h1>
          <p className="registrations-count">{capacityText}</p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="primary"
            onClick={downloadCsv}
            disabled={!data || data.total === 0}
          >
            Download CSV
          </Button>
          {/* Hidden anchor — browser triggers download with cookies automatically */}
          <a
            ref={csvLinkRef}
            href={`${BASE_URL}/api/v1/admin/events/${id}/registrations.csv`}
            download
            style={{ display: 'none' }}
            aria-hidden="true"
          />
          <Button as="a" href={`/admin/events/${id}/edit`} variant="secondary">
            Back to Event
          </Button>
          <Button as="a" href="/admin/events" variant="secondary">
            All Events
          </Button>
        </div>
      </div>

      {isError && (
        <div className="admin-state admin-state-error">
          Failed to load registrations:{' '}
          {isApiError(error) ? error.body.message : 'Network error. Please try again.'}
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="admin-state admin-state-empty">
          No registrations yet for this event.
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>First name</th>
                <th>Surname</th>
                <th>Age</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((reg) => (
                <tr key={reg.id}>
                  <td>{reg.firstName}</td>
                  <td>{reg.surname}</td>
                  <td>{reg.age}</td>
                  <td>
                    <a href={`mailto:${reg.email}`} style={{ color: 'var(--accent)' }}>
                      {reg.email}
                    </a>
                  </td>
                  <td>{reg.phone}</td>
                  <td style={{ fontSize: '0.82rem' }}>{formatDateTime(reg.registeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pageCount > 1 && (
        <p className="admin-form-hint" style={{ marginTop: '1rem', textAlign: 'center' }}>
          Showing first {PAGE_LIMIT} of {data.total} registrations. Use the CSV export to see all.
        </p>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <Link to="/admin/events" style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
          &larr; Back to all events
        </Link>
      </div>
    </div>
  );
}
