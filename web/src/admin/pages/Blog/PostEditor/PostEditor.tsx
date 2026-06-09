/**
 * PostEditor — create or edit a blog post.
 *
 * Detects create vs edit by useParams().id.
 * - Create: POST /api/v1/admin/blog/posts → redirect to /admin/blog/:id/edit
 * - Edit: GET /api/v1/admin/blog/posts/:id (seed form), PATCH on save
 * - Slug: read-only; locked note when published; Admin-only inline edit
 * - Publish / Unpublish alongside Save
 * - Image section: only shown when post.id exists (gate on saved post)
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm, useController } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { useHasRole } from '@/admin/components/useHasRole';
import { Button } from '@/design-system/Button';
import { FormField } from '@/design-system/FormField';
import { RichTextEditor } from '@/admin/components/RichTextEditor';
import { ImageUploadField } from '@/admin/components/ImageUploadField';
import { formatDateTime } from '@/shared/utils/formatDate';
import type { AdminBlogPost, MediaAsset } from '@/shared/types';
import '@/admin/admin.css';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

const postSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  body: z.string().min(1, 'Body is required'),
});

type PostFormValues = z.infer<typeof postSchema>;

export function PostEditor() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = useHasRole('ADMIN');

  const [slugEditing, setSlugEditing] = useState(false);
  // slugDraft only exists during active editing; display uses post.slug when not editing
  const [slugDraft, setSlugDraft] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [slugSaving, setSlugSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Extra media uploaded during this session (not yet in the query cache)
  const [uploadedMedia, setUploadedMedia] = useState<MediaAsset[]>([]);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<PostFormValues>({
    resolver: zodResolver(postSchema),
    defaultValues: { title: '', body: '' },
  });

  const { field: bodyField } = useController({ name: 'body', control });

  // Fetch existing post in edit mode
  const { data: post, isLoading: postLoading } = useQuery<AdminBlogPost>({
    queryKey: ['adminBlogPost', id],
    queryFn: () => apiFetch<AdminBlogPost>(`/api/v1/admin/blog/posts/${id}`),
    enabled: !isNew,
  });

  // Fetch existing media for this post
  const { data: mediaData } = useQuery<{ items: MediaAsset[] }>({
    queryKey: ['adminBlogMedia', id],
    queryFn: () =>
      apiFetch<{ items: MediaAsset[] }>(
        `/api/v1/admin/media?ownerType=BLOG_POST&ownerId=${id}`
      ),
    enabled: !isNew && !!id,
  });

  useEffect(() => {
    if (post) {
      reset({ title: post.title, body: post.body });
    }
  }, [post, reset]);

  function invalidateCaches() {
    queryClient.invalidateQueries({ queryKey: ['adminBlogPosts'] });
    queryClient.invalidateQueries({ queryKey: ['adminBlogPost', id] });
    queryClient.invalidateQueries({ queryKey: ['blogPosts'] });
  }

  const createMutation = useMutation({
    mutationFn: (values: PostFormValues) =>
      apiFetch<AdminBlogPost>('/api/v1/admin/blog/posts', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: (created) => {
      invalidateCaches();
      navigate(`/admin/blog/${created.id}/edit`, { replace: true });
    },
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Create failed');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (values: Partial<PostFormValues>) =>
      apiFetch<AdminBlogPost>(`/api/v1/admin/blog/posts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      }),
    onSuccess: () => invalidateCaches(),
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Save failed');
    },
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/admin/blog/posts/${id}/publish`, { method: 'POST' }),
    onSuccess: () => invalidateCaches(),
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Publish failed');
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/admin/blog/posts/${id}/unpublish`, { method: 'POST' }),
    onSuccess: () => invalidateCaches(),
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Unpublish failed');
    },
  });

  async function saveSlug() {
    if (!id) return;
    setSlugSaving(true);
    setSlugError(null);
    try {
      await apiFetch<void>(`/api/v1/admin/blog/posts/${id}/slug`, {
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

  function onSubmit(values: PostFormValues) {
    setActionError(null);
    if (isNew) {
      createMutation.mutate(values);
    } else {
      updateMutation.mutate(values);
    }
  }

  // Derive full media list: fetched items + newly uploaded this session
  const mediaList = [...uploadedMedia, ...(mediaData?.items ?? [])];

  function handleMediaUploaded(asset: MediaAsset) {
    setUploadedMedia((prev) => [asset, ...prev]);
  }

  const isBusy =
    isSubmitting ||
    createMutation.isPending ||
    updateMutation.isPending ||
    publishMutation.isPending ||
    unpublishMutation.isPending;

  if (!isNew && postLoading) {
    return <div className="admin-state">Loading post…</div>;
  }

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">{isNew ? 'New Post' : 'Edit Post'}</h1>
        <div className="admin-page-actions">
          <Button as="a" href="/admin/blog" variant="secondary">
            Back to Posts
          </Button>
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
            htmlFor="post-title"
            errorMessage={errors.title?.message}
            errorId="post-title-error"
          >
            <input
              id="post-title"
              type="text"
              placeholder="Post title"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? 'post-title-error' : undefined}
              {...register('title')}
            />
          </FormField>
        </div>

        {/* Slug display */}
        {!isNew && post && (
          <div className="admin-form-group">
            <span className="admin-form-hint" style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 600, color: 'var(--muted)' }}>
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
                    aria-label="Post slug"
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
                  <Button
                    variant="primary"
                    onClick={saveSlug}
                    disabled={slugSaving}
                  >
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
                  <span className="admin-slug-text">{post.slug}</span>
                  {post.status === 'PUBLISHED' && (
                    <span className="admin-form-hint" style={{ marginTop: 0 }}>
                      Slug is locked — changing title won&rsquo;t change the URL.
                    </span>
                  )}
                  {isAdmin && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSlugDraft(post.slug);
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
            label="Body"
            htmlFor="post-body"
            errorMessage={errors.body?.message}
            errorId="post-body-error"
          >
            {/* Hidden input for accessibility binding — TipTap manages actual content */}
            <input type="hidden" id="post-body" aria-hidden="true" />
          </FormField>
          <RichTextEditor
            value={bodyField.value}
            onChange={bodyField.onChange}
            mediaOwner={!isNew && id ? { ownerType: 'BLOG_POST', ownerId: id } : undefined}
            onMediaUploaded={handleMediaUploaded}
          />
        </div>

        <div className="admin-form-actions">
          <Button type="submit" variant="primary" disabled={isBusy}>
            {isBusy && (isNew ? createMutation.isPending : updateMutation.isPending)
              ? 'Saving…'
              : 'Save'}
          </Button>

          {!isNew && post && (
            <>
              {post.status === 'DRAFT' && (
                <Button
                  variant="primary"
                  disabled={isBusy}
                  onClick={() => {
                    setActionError(null);
                    publishMutation.mutate();
                  }}
                >
                  {publishMutation.isPending ? 'Publishing…' : 'Publish'}
                </Button>
              )}
              {post.status === 'PUBLISHED' && (
                <Button
                  variant="secondary"
                  disabled={isBusy}
                  onClick={() => {
                    setActionError(null);
                    unpublishMutation.mutate();
                  }}
                >
                  {unpublishMutation.isPending ? 'Unpublishing…' : 'Unpublish'}
                </Button>
              )}
            </>
          )}
        </div>
      </form>

      {/* Images section — only when post exists */}
      {!isNew && id && (
        <section style={{ marginTop: '2rem' }}>
          <h2 className="admin-section-heading">Images</h2>
          <p className="admin-form-hint" style={{ marginBottom: '0.75rem' }}>
            Uploaded images are also inserted via the editor toolbar above.
          </p>
          <ImageUploadField
            ownerType="BLOG_POST"
            ownerId={id}
            onUploaded={handleMediaUploaded}
          />
          {mediaList.length > 0 && (
            <div className="admin-media-list" style={{ marginTop: '1rem' }}>
              {mediaList.map((asset) => (
                <div key={asset.id} className="admin-media-item">
                  <img
                    src={`${BASE_URL}${asset.url}`}
                    alt={asset.altText ?? ''}
                    loading="lazy"
                  />
                  <span className="admin-media-item-url" title={asset.url}>
                    {asset.url.split('/').pop()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Post metadata footer */}
      {!isNew && post && (
        <footer
          style={{
            marginTop: '2rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--line)',
            fontSize: '0.82rem',
            color: 'var(--muted)',
            display: 'flex',
            gap: '1.5rem',
            flexWrap: 'wrap',
          }}
        >
          <span>Created: {formatDateTime(post.createdAt)}</span>
          <span>Updated: {formatDateTime(post.updatedAt)}</span>
          {post.publishedAt && <span>Published: {formatDateTime(post.publishedAt)}</span>}
        </footer>
      )}
    </div>
  );
}
