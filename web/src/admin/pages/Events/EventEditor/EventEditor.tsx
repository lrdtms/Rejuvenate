/**
 * EventEditor — create or edit an event.
 *
 * Fields: title, description (plain textarea), branch, startsAt, endsAt,
 *         locationDetail, capacity.
 * NO isPaid / priceCents — dormant per ADR-0006, hidden entirely.
 *
 * Status transitions: only valid ones from current status.
 * Before CANCEL: confirmation dialog with registration count.
 *
 * Slug: read-only + Admin-only inline edit.
 * Images: gated on saved event id.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { useHasRole } from '@/admin/components/useHasRole';
import { Button } from '@/design-system/Button';
import { FormField } from '@/design-system/FormField';
import { ImageUploadField } from '@/admin/components/ImageUploadField';
import type { AdminEvent, RegistrationsPage, MediaAsset } from '@/shared/types';
import '@/admin/admin.css';

// Valid transitions FROM a given status
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

// datetime-local value helper: converts ISO string ↔ input value
function toDatetimeLocal(iso: string): string {
  if (!iso) return '';
  // Trim seconds and timezone to match datetime-local format
  return iso.slice(0, 16);
}

const eventSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
  branch: z.enum(['CAPE_TOWN', 'DURBAN'], { message: 'Branch is required' }),
  startsAt: z.string().min(1, 'Start date/time is required'),
  endsAt: z.string().optional(),
  locationDetail: z.string().optional(),
  capacity: z.string().optional(),
});

type EventFormValues = z.infer<typeof eventSchema>;

export function EventEditor() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = useHasRole('ADMIN');

  const [slugEditing, setSlugEditing] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [slugSaving, setSlugSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [uploadedMedia, setUploadedMedia] = useState<MediaAsset[]>([]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema),
    defaultValues: {
      title: '',
      description: '',
      branch: 'CAPE_TOWN',
      startsAt: '',
      endsAt: '',
      locationDetail: '',
      capacity: '',
    },
  });

  // Fetch existing event in edit mode
  const { data: event, isLoading: eventLoading } = useQuery<AdminEvent>({
    queryKey: ['adminEvent', id],
    queryFn: () => apiFetch<AdminEvent>(`/api/v1/admin/events/${id}`),
    enabled: !isNew,
  });

  // Fetch registration count for cancel confirmation
  const { data: regData } = useQuery<RegistrationsPage>({
    queryKey: ['adminEventRegs', id, 'count'],
    queryFn: () =>
      apiFetch<RegistrationsPage>(`/api/v1/admin/events/${id}/registrations?limit=1`),
    enabled: !isNew && !!id,
  });

  // Fetch media
  const { data: mediaData } = useQuery<{ items: MediaAsset[] }>({
    queryKey: ['adminEventMedia', id],
    queryFn: () =>
      apiFetch<{ items: MediaAsset[] }>(
        `/api/v1/admin/media?ownerType=EVENT&ownerId=${id}`
      ),
    enabled: !isNew && !!id,
  });

  useEffect(() => {
    if (event) {
      reset({
        title: event.title,
        description: event.description,
        branch: event.branch,
        startsAt: toDatetimeLocal(event.startsAt),
        endsAt: event.endsAt ? toDatetimeLocal(event.endsAt) : '',
        locationDetail: event.locationDetail ?? '',
        capacity: event.capacity != null ? String(event.capacity) : '',
      });
    }
  }, [event, reset]);

  function invalidateCaches() {
    queryClient.invalidateQueries({ queryKey: ['adminEvents'] });
    queryClient.invalidateQueries({ queryKey: ['adminEvent', id] });
    queryClient.invalidateQueries({ queryKey: ['events'] });
  }

  const createMutation = useMutation({
    mutationFn: (values: EventFormValues) => {
      const body: Record<string, unknown> = {
        title: values.title,
        description: values.description,
        branch: values.branch,
        startsAt: values.startsAt ? new Date(values.startsAt).toISOString() : undefined,
        endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : undefined,
        locationDetail: values.locationDetail || undefined,
        capacity: values.capacity ? parseInt(values.capacity, 10) : undefined,
      };
      return apiFetch<AdminEvent>('/api/v1/admin/events', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: (created) => {
      invalidateCaches();
      navigate(`/admin/events/${created.id}/edit`, { replace: true });
    },
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Create failed');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (values: EventFormValues) => {
      const body: Record<string, unknown> = {
        title: values.title,
        description: values.description,
        branch: values.branch,
        startsAt: values.startsAt ? new Date(values.startsAt).toISOString() : undefined,
        endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : null,
        locationDetail: values.locationDetail || null,
        capacity: values.capacity ? parseInt(values.capacity, 10) : null,
      };
      return apiFetch<AdminEvent>(`/api/v1/admin/events/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => invalidateCaches(),
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Save failed');
    },
  });

  const transitionMutation = useMutation({
    mutationFn: (to: AdminEvent['status']) =>
      apiFetch<void>(`/api/v1/admin/events/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
    onSuccess: () => {
      invalidateCaches();
      setCancelConfirm(false);
    },
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Status change failed');
      setCancelConfirm(false);
    },
  });

  async function saveSlug() {
    if (!id) return;
    setSlugSaving(true);
    setSlugError(null);
    try {
      await apiFetch<void>(`/api/v1/admin/events/${id}/slug`, {
        method: 'PATCH',
        body: JSON.stringify({ slug: slugDraft }),
      });
      invalidateCaches();
      setSlugEditing(false);
    } catch (err) {
      setSlugError(isApiError(err) ? err.body.message : 'Failed to update slug');
    } finally {
      setSlugSaving(false);
    }
  }

  function onSubmit(values: EventFormValues) {
    setActionError(null);
    if (isNew) {
      createMutation.mutate(values);
    } else {
      updateMutation.mutate(values);
    }
  }

  function handleTransition(to: AdminEvent['status']) {
    setActionError(null);
    if (to === 'CANCELLED') {
      setCancelConfirm(true);
      return;
    }
    transitionMutation.mutate(to);
  }

  const regCount = regData?.total ?? 0;
  const isBusy = isSubmitting || createMutation.isPending || updateMutation.isPending || transitionMutation.isPending;

  // Derive full media list: newly uploaded this session + fetched items
  const mediaList = [...uploadedMedia, ...(mediaData?.items ?? [])];

  if (!isNew && eventLoading) {
    return <div className="admin-state">Loading event…</div>;
  }

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">{isNew ? 'New Event' : 'Edit Event'}</h1>
        <div className="admin-page-actions">
          <Button as="a" href="/admin/events" variant="secondary">
            Back to Events
          </Button>
          {!isNew && (
            <Button
              as="a"
              href={`/admin/events/${id}/registrations`}
              variant="secondary"
            >
              Registrations {regCount > 0 ? `(${regCount})` : ''}
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div role="alert" style={{ color: '#ff6b6b', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {actionError}{' '}
          <button
            type="button"
            onClick={() => setActionError(null)}
            style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer' }}
            aria-label="Dismiss error"
          >
            &times;
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="admin-form" noValidate>
        <div className="admin-form-group">
          <FormField
            label="Title"
            htmlFor="event-title"
            errorMessage={errors.title?.message}
            errorId="event-title-error"
          >
            <input
              id="event-title"
              type="text"
              placeholder="Event title"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? 'event-title-error' : undefined}
              {...register('title')}
            />
          </FormField>
        </div>

        {/* Slug — edit mode only */}
        {!isNew && event && (
          <div className="admin-form-group">
            <span
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--muted)',
                marginBottom: '0.4rem',
              }}
            >
              Slug
            </span>
            <div className="admin-slug-row">
              {slugEditing ? (
                <>
                  <input
                    className="admin-slug-input"
                    type="text"
                    value={slugDraft}
                    onChange={(e) => setSlugDraft(e.target.value)}
                    aria-label="Event slug"
                    style={{
                      background: 'var(--panel-strong)',
                      border: '1px solid var(--line)',
                      borderRadius: '6px',
                      color: 'var(--text)',
                      fontFamily: 'monospace',
                      fontSize: '0.875rem',
                      padding: '0.35rem 0.55rem',
                    }}
                  />
                  <Button variant="primary" onClick={saveSlug} disabled={slugSaving}>
                    {slugSaving ? 'Saving…' : 'Save'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSlugEditing(false);
                      setSlugError(null);
                    }}
                    disabled={slugSaving}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className="admin-slug-text">{event.slug}</span>
                  {event.status === 'PUBLISHED' && (
                    <span className="admin-form-hint" style={{ marginTop: 0 }}>
                      Slug is locked — changing title won&rsquo;t change the URL.
                    </span>
                  )}
                  {isAdmin && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSlugDraft(event.slug);
                        setSlugEditing(true);
                      }}
                    >
                      Edit slug
                    </Button>
                  )}
                </>
              )}
            </div>
            {slugError && (
              <span role="alert" style={{ fontSize: '0.82rem', color: '#ff6b6b', display: 'block', marginTop: '0.25rem' }}>
                {slugError}
              </span>
            )}
          </div>
        )}

        <div className="admin-form-group">
          <FormField
            label="Description"
            htmlFor="event-description"
            errorMessage={errors.description?.message}
            errorId="event-description-error"
          >
            <textarea
              id="event-description"
              placeholder="Event description"
              aria-invalid={!!errors.description}
              aria-describedby={errors.description ? 'event-description-error' : undefined}
              rows={4}
              {...register('description')}
            />
          </FormField>
        </div>

        <div className="admin-form-group">
          <FormField
            label="Branch"
            htmlFor="event-branch"
            errorMessage={errors.branch?.message}
            errorId="event-branch-error"
          >
            <select
              id="event-branch"
              aria-invalid={!!errors.branch}
              aria-describedby={errors.branch ? 'event-branch-error' : undefined}
              {...register('branch')}
            >
              <option value="CAPE_TOWN">Cape Town</option>
              <option value="DURBAN">Durban</option>
            </select>
          </FormField>
        </div>

        <div className="admin-form-row">
          <div className="admin-form-group">
            <FormField
              label="Starts at"
              htmlFor="event-startsAt"
              errorMessage={errors.startsAt?.message}
              errorId="event-startsAt-error"
            >
              <input
                id="event-startsAt"
                type="datetime-local"
                aria-invalid={!!errors.startsAt}
                aria-describedby={errors.startsAt ? 'event-startsAt-error' : undefined}
                {...register('startsAt')}
              />
            </FormField>
          </div>
          <div className="admin-form-group">
            <FormField label="Ends at (optional)" htmlFor="event-endsAt">
              <input
                id="event-endsAt"
                type="datetime-local"
                {...register('endsAt')}
              />
            </FormField>
          </div>
        </div>

        <div className="admin-form-row">
          <div className="admin-form-group">
            <FormField label="Location detail (optional)" htmlFor="event-location">
              <input
                id="event-location"
                type="text"
                placeholder="e.g. Main Hall, 12 Church Street"
                {...register('locationDetail')}
              />
            </FormField>
          </div>
          <div className="admin-form-group">
            <FormField label="Capacity (optional)" htmlFor="event-capacity">
              <input
                id="event-capacity"
                type="number"
                min="1"
                placeholder="Leave blank for unlimited"
                {...register('capacity')}
              />
            </FormField>
          </div>
        </div>

        <div className="admin-form-actions">
          <Button type="submit" variant="primary" disabled={isBusy}>
            {isBusy && (isNew ? createMutation.isPending : updateMutation.isPending)
              ? 'Saving…'
              : 'Save'}
          </Button>

          {/* Status transition buttons — only shown in edit mode */}
          {!isNew && event &&
            TRANSITIONS[event.status].map((to) => (
              <Button
                key={to}
                variant={to === 'PUBLISHED' ? 'primary' : 'secondary'}
                className={to === 'CANCELLED' ? 'btn-danger' : undefined}
                disabled={isBusy}
                onClick={() => handleTransition(to)}
              >
                {TRANSITION_LABELS[to]}
              </Button>
            ))}
        </div>
      </form>

      {/* Image section — only when event exists */}
      {!isNew && id && (
        <section style={{ marginTop: '2rem' }}>
          <h2 className="admin-section-heading">Images</h2>
          <ImageUploadField
            ownerType="EVENT"
            ownerId={id}
            onUploaded={(asset) => setUploadedMedia((prev) => [asset, ...prev])}
          />
          {mediaList.length > 0 && (
            <div className="admin-media-list" style={{ marginTop: '1rem' }}>
              {mediaList.map((asset) => (
                <div key={asset.id} className="admin-media-item">
                  <img src={asset.url} alt={asset.altText ?? ''} loading="lazy" />
                  <span className="admin-media-item-url" title={asset.url}>
                    {asset.url.split('/').pop()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Cancel confirmation dialog */}
      {cancelConfirm && (
        <div
          className="admin-dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-event-dialog-title"
        >
          <div className="admin-dialog">
            <h2 id="cancel-event-dialog-title">Cancel event?</h2>
            <p>
              {regCount > 0
                ? `This event has ${regCount} registration${regCount !== 1 ? 's' : ''}. Cancelling will not notify them automatically.`
                : 'This event has no registrations.'}
              {' '}Are you sure you want to cancel it?
            </p>
            <div className="admin-dialog-actions">
              <Button
                variant="secondary"
                onClick={() => setCancelConfirm(false)}
                disabled={transitionMutation.isPending}
              >
                Go back
              </Button>
              <Button
                variant="primary"
                className="btn-danger"
                disabled={transitionMutation.isPending}
                onClick={() => transitionMutation.mutate('CANCELLED')}
              >
                {transitionMutation.isPending ? 'Cancelling…' : 'Cancel event'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
