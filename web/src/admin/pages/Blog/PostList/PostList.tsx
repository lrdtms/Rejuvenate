/**
 * PostList — admin blog post list.
 *
 * - Paginated list with title, status badge, publishedAt, author (Admin-only), createdAt.
 * - Actions per row: Edit, Delete (confirm dialog), Publish/Unpublish.
 * - "New Post" button.
 * - After any mutation: invalidates both adminBlogPosts and public blogPosts caches.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { useHasRole } from '@/admin/components/useHasRole';
import { Button } from '@/design-system/Button';
import { formatDateTime } from '@/shared/utils/formatDate';
import type { AdminBlogPost, AdminBlogPostsPage } from '@/shared/types';
import '@/admin/admin.css';

const PAGE_LIMIT = 20;

export function PostList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const isAdmin = useHasRole('ADMIN');
  const queryClient = useQueryClient();

  const [deleteTarget, setDeleteTarget] = useState<AdminBlogPost | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery<AdminBlogPostsPage>({
    queryKey: ['adminBlogPosts', page],
    queryFn: () =>
      apiFetch<AdminBlogPostsPage>(`/api/v1/admin/blog/posts?page=${page}&limit=${PAGE_LIMIT}`),
  });

  function invalidateCaches() {
    queryClient.invalidateQueries({ queryKey: ['adminBlogPosts'] });
    queryClient.invalidateQueries({ queryKey: ['blogPosts'] });
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/blog/posts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidateCaches();
    },
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Delete failed');
    },
  });

  const publishMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/blog/posts/${id}/publish`, { method: 'POST' }),
    onSuccess: invalidateCaches,
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Publish failed');
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/blog/posts/${id}/unpublish`, { method: 'POST' }),
    onSuccess: invalidateCaches,
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Unpublish failed');
    },
  });

  function goToPage(n: number) {
    setSearchParams({ page: String(n) });
  }

  const isActing =
    deleteMutation.isPending || publishMutation.isPending || unpublishMutation.isPending;

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">Blog Posts</h1>
        <div className="admin-page-actions">
          <Button as="a" href="/admin/blog/new" variant="primary">
            New Post
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

      {isLoading && <div className="admin-state">Loading posts…</div>}

      {isError && (
        <div className="admin-state admin-state-error">
          Failed to load posts:{' '}
          {isApiError(error) ? error.body.message : 'Network error. Please try again.'}
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="admin-state admin-state-empty">
          No posts yet.{' '}
          <Link to="/admin/blog/new" style={{ color: 'var(--accent)' }}>
            Create your first post
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
                  <th>Status</th>
                  <th>Published</th>
                  {isAdmin && <th>Author</th>}
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <Link
                        to={`/admin/blog/${post.id}/edit`}
                        style={{ color: 'var(--text)', fontWeight: 600 }}
                      >
                        {post.title}
                      </Link>
                    </td>
                    <td>
                      <span
                        className={`badge ${post.status === 'PUBLISHED' ? 'badge-published' : 'badge-draft'}`}
                      >
                        {post.status === 'PUBLISHED' ? 'Published' : 'Draft'}
                      </span>
                    </td>
                    <td>{post.publishedAt ? formatDateTime(post.publishedAt) : '—'}</td>
                    {isAdmin && <td>{post.author.email}</td>}
                    <td>{formatDateTime(post.createdAt)}</td>
                    <td>
                      <div className="admin-table-actions">
                        <Button
                          as="a"
                          href={`/admin/blog/${post.id}/edit`}
                          variant="secondary"
                        >
                          Edit
                        </Button>
                        {post.status === 'DRAFT' && (
                          <Button
                            variant="primary"
                            disabled={isActing}
                            onClick={() => {
                              setActionError(null);
                              publishMutation.mutate(post.id);
                            }}
                          >
                            Publish
                          </Button>
                        )}
                        {post.status === 'PUBLISHED' && (
                          <Button
                            variant="secondary"
                            disabled={isActing}
                            onClick={() => {
                              setActionError(null);
                              unpublishMutation.mutate(post.id);
                            }}
                          >
                            Unpublish
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          disabled={isActing}
                          className="btn-danger"
                          onClick={() => {
                            setActionError(null);
                            setDeleteTarget(post);
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
                Page {data.page} of {data.pageCount} ({data.total} posts)
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
        <div className="admin-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
          <div className="admin-dialog">
            <h2 id="delete-dialog-title">Delete post?</h2>
            <p>
              Delete <strong>&ldquo;{deleteTarget.title}&rdquo;</strong>? This cannot be undone.
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
                disabled={deleteMutation.isPending}
                className="btn-danger"
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
