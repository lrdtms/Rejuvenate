/**
 * EventList — admin events list.
 *
 * - Branch filter (All / Cape Town / Durban) + temporal filter (upcoming / past / all)
 * - Table: title, branch, status, startsAt/endsAt, capacity
 * - Actions: Edit, View Registrations, Delete (409-aware), status transitions
 * - Status transitions: only valid ones per the transition graph
 * - Pagination with URL ?page=N
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { Button } from '@/design-system/Button';
import { formatEventDateRange } from '@/shared/utils/formatDate';
import type { AdminEvent, AdminEventsPage } from '@/shared/types';
import '@/admin/admin.css';

const PAGE_LIMIT = 20;

// All valid status transitions per the backend transition graph
const TRANSITIONS: Record<AdminEvent['status'], AdminEvent['status'][]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['DRAFT', 'CANCELLED'],
  CANCELLED: ['DRAFT', 'PUBLISHED'],
};

const TRANSITION_LABELS: Record<AdminEvent['status'], string> = {
  DRAFT: 'Set Draft',
  PUBLISHED: 'Publish',
  CANCELLED: 'Cancel',
};

const BRANCH_LABELS: Record<string, string> = {
  CAPE_TOWN: 'Cape Town',
  DURBAN: 'Durban',
};

export function EventList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const branch = searchParams.get('branch') ?? '';
  const temporal = searchParams.get('temporal') ?? '';
  const queryClient = useQueryClient();

  const [deleteTarget, setDeleteTarget] = useState<AdminEvent | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function buildQuery() {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
    if (branch) params.set('branch', branch);
    if (temporal) params.set('temporal', temporal);
    return params.toString();
  }

  const { data, isLoading, isError, error } = useQuery<AdminEventsPage>({
    queryKey: ['adminEvents', page, branch, temporal],
    queryFn: () => apiFetch<AdminEventsPage>(`/api/v1/admin/events?${buildQuery()}`),
  });

  function invalidateCaches() {
    queryClient.invalidateQueries({ queryKey: ['adminEvents'] });
    queryClient.invalidateQueries({ queryKey: ['events'] });
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/events/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidateCaches();
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.body.message : 'Delete failed';
      // 409 = registrations exist
      const is409 = isApiError(err) && err.status === 409;
      setDeleteError(is409 ? 'Cannot delete — event has registrations.' : msg);
      setDeleteTarget(null);
    },
  });

  const transitionMutation = useMutation({
    mutationFn: ({ id, to }: { id: string; to: AdminEvent['status'] }) =>
      apiFetch<void>(`/api/v1/admin/events/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
    onSuccess: invalidateCaches,
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Status change failed');
    },
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    next.delete('page');
    setSearchParams(next);
  }

  function goToPage(n: number) {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(n));
    setSearchParams(next);
  }

  function statusBadgeClass(status: AdminEvent['status']) {
    if (status === 'PUBLISHED') return 'badge badge-published';
    if (status === 'CANCELLED') return 'badge badge-cancelled';
    return 'badge badge-draft';
  }

  const isActing = deleteMutation.isPending || transitionMutation.isPending;

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">Events</h1>
        <div className="admin-page-actions">
          <Button as="a" href="/admin/events/new" variant="primary">
            New Event
          </Button>
        </div>
      </div>

      <div className="admin-filters">
        <select
          className="admin-filter-select"
          value={branch}
          onChange={(e) => setParam('branch', e.target.value)}
          aria-label="Filter by branch"
        >
          <option value="">All branches</option>
          <option value="CAPE_TOWN">Cape Town</option>
          <option value="DURBAN">Durban</option>
        </select>

        <select
          className="admin-filter-select"
          value={temporal}
          onChange={(e) => setParam('temporal', e.target.value)}
          aria-label="Filter by time"
        >
          <option value="">All time</option>
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
        </select>
      </div>

      {(actionError || deleteError) && (
        <div role="alert" style={{ color: '#ff6b6b', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {actionError ?? deleteError}{' '}
          <button
            type="button"
            onClick={() => { setActionError(null); setDeleteError(null); }}
            style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer' }}
            aria-label="Dismiss error"
          >
            &times;
          </button>
        </div>
      )}

      {isLoading && <div className="admin-state">Loading events…</div>}

      {isError && (
        <div className="admin-state admin-state-error">
          Failed to load events:{' '}
          {isApiError(error) ? error.body.message : 'Network error. Please try again.'}
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="admin-state admin-state-empty">
          No events found.{' '}
          <Link to="/admin/events/new" style={{ color: 'var(--accent)' }}>
            Create your first event
          </Link>
          .
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Branch</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Capacity</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <Link
                        to={`/admin/events/${event.id}/edit`}
                        style={{ color: 'var(--text)', fontWeight: 600 }}
                      >
                        {event.title}
                      </Link>
                    </td>
                    <td>{BRANCH_LABELS[event.branch] ?? event.branch}</td>
                    <td>
                      <span className={statusBadgeClass(event.status)}>
                        {event.status.charAt(0) + event.status.slice(1).toLowerCase()}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.82rem' }}>
                      {formatEventDateRange(event.startsAt, event.endsAt)}
                    </td>
                    <td>{event.capacity ?? '—'}</td>
                    <td>
                      <div className="admin-table-actions">
                        <Button
                          as="a"
                          href={`/admin/events/${event.id}/edit`}
                          variant="secondary"
                        >
                          Edit
                        </Button>
                        <Button
                          as="a"
                          href={`/admin/events/${event.id}/registrations`}
                          variant="secondary"
                        >
                          Registrations
                        </Button>

                        {/* Status transitions — only valid ones */}
                        {TRANSITIONS[event.status].map((to) => (
                          <Button
                            key={to}
                            variant={to === 'PUBLISHED' ? 'primary' : 'secondary'}
                            className={to === 'CANCELLED' ? 'btn-danger' : undefined}
                            disabled={isActing}
                            onClick={() => {
                              setActionError(null);
                              transitionMutation.mutate({ id: event.id, to });
                            }}
                          >
                            {TRANSITION_LABELS[to]}
                          </Button>
                        ))}

                        <Button
                          variant="secondary"
                          className="btn-danger"
                          disabled={isActing}
                          onClick={() => {
                            setActionError(null);
                            setDeleteError(null);
                            setDeleteTarget(event);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pageCount > 1 && (
            <div className="admin-pagination">
              <span className="admin-pagination-info">
                Page {data.page} of {data.pageCount} ({data.total} events)
              </span>
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={page >= data.pageCount}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div
          className="admin-dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-event-dialog-title"
        >
          <div className="admin-dialog">
            <h2 id="delete-event-dialog-title">Delete event?</h2>
            <p>
              Delete <strong>&ldquo;{deleteTarget.title}&rdquo;</strong>? This cannot be undone.
              If there are registrations for this event the deletion will be blocked.
            </p>
            <div className="admin-dialog-actions">
              <Button
                variant="secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="btn-danger"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
