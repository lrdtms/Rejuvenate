/**
 * StaffAccountList — admin-only staff account list.
 *
 * Table: email, role badge, isActive status (Active/Deactivated — NOT deleted),
 * createdAt. Edit action → /admin/users/:id/edit.
 * "New Staff Account" button → /admin/users/new.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiFetch, isApiError } from '@/shared/api/client';
import { Button } from '@/design-system/Button';
import { formatDateTime } from '@/shared/utils/formatDate';
import type { AdminUserView, AdminUsersResponse } from '@/shared/types';
import '@/admin/admin.css';

const ROLE_LABELS: Record<AdminUserView['role'], string> = {
  ADMIN: 'Admin',
  BLOGGER: 'Blogger',
  EVENT_MANAGER: 'Event Manager',
};

const ROLE_BADGE_CLASS: Record<AdminUserView['role'], string> = {
  ADMIN: 'badge badge-admin',
  BLOGGER: 'badge badge-blogger',
  EVENT_MANAGER: 'badge badge-event-manager',
};

export function StaffAccountList() {
  const { data, isLoading, isError, error } = useQuery<AdminUsersResponse>({
    queryKey: ['adminUsers'],
    queryFn: () => apiFetch<AdminUsersResponse>('/api/v1/admin/users'),
  });

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">Staff Accounts</h1>
        <div className="admin-page-actions">
          <Button as="a" href="/admin/users/new" variant="primary">
            New Staff Account
          </Button>
        </div>
      </div>

      {isLoading && <div className="admin-state">Loading staff accounts…</div>}

      {isError && (
        <div className="admin-state admin-state-error">
          Failed to load accounts:{' '}
          {isApiError(error) ? error.body.message : 'Network error. Please try again.'}
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="admin-state admin-state-empty">
          No staff accounts found.{' '}
          <Link to="/admin/users/new" style={{ color: 'var(--accent)' }}>
            Create one
          </Link>
          .
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((user) => (
                <tr key={user.id}>
                  <td style={{ fontWeight: 600 }}>{user.email}</td>
                  <td>
                    <span className={ROLE_BADGE_CLASS[user.role] ?? 'badge badge-draft'}>
                      {ROLE_LABELS[user.role] ?? user.role}
                    </span>
                  </td>
                  <td>
                    <span
                      className={user.isActive ? 'badge badge-active' : 'badge badge-deactivated'}
                    >
                      {user.isActive ? 'Active' : 'Deactivated'}
                    </span>
                  </td>
                  <td>{formatDateTime(user.createdAt)}</td>
                  <td>
                    <div className="admin-table-actions">
                      <Button
                        as="a"
                        href={`/admin/users/${user.id}/edit`}
                        variant="secondary"
                      >
                        Edit
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
