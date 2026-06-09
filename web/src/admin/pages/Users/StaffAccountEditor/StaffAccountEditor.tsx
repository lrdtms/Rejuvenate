/**
 * StaffAccountEditor — create or edit a staff account.
 *
 * Create:
 *  - Fields: email, role
 *  - On success: show temporaryPassword once in a clearly-marked box.
 *    The admin copies it and clicks "Done" to navigate away.
 *
 * Edit:
 *  - Fields: email, role, isActive (checkbox)
 *  - Guard rails (pre-emptive UX, mirrors backend enforcement):
 *    - Disable role/isActive controls if: target is the current user
 *    - Disable deactivate / demote if: target is the last active Admin
 *  - No DELETE — deactivate via isActive: false
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import { Button } from '@/design-system/Button';
import { FormField } from '@/design-system/FormField';
import { formatDateTime } from '@/shared/utils/formatDate';
import type { AdminUserView, AdminUsersResponse, CreateUserResponse } from '@/shared/types';
import '@/admin/admin.css';

const createSchema = z.object({
  email: z.string().email('Valid email required'),
  role: z.enum(['ADMIN', 'BLOGGER', 'EVENT_MANAGER'], { message: 'Role is required' }),
});

const editSchema = z.object({
  email: z.string().email('Valid email required'),
  role: z.enum(['ADMIN', 'BLOGGER', 'EVENT_MANAGER'], { message: 'Role is required' }),
  isActive: z.boolean(),
});

type CreateFormValues = z.infer<typeof createSchema>;
type EditFormValues = z.infer<typeof editSchema>;

export function StaffAccountEditor() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user: currentUser } = useCurrentUser();

  const [actionError, setActionError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<AdminUserView | null>(null);

  // For create mode
  const createForm = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { email: '', role: 'BLOGGER' },
  });

  // For edit mode
  const editForm = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { email: '', role: 'BLOGGER', isActive: true },
  });

  const form = isNew ? createForm : editForm;
  const errors = form.formState.errors;

  // Fetch all users (for last-admin guard)
  const { data: allUsersData } = useQuery<AdminUsersResponse>({
    queryKey: ['adminUsers'],
    queryFn: () => apiFetch<AdminUsersResponse>('/api/v1/admin/users'),
  });

  // Fetch target user in edit mode
  const { data: targetUser, isLoading: targetLoading } = useQuery<AdminUserView>({
    queryKey: ['adminUser', id],
    queryFn: () => apiFetch<AdminUserView>(`/api/v1/admin/users/${id}`),
    enabled: !isNew,
  });

  useEffect(() => {
    if (targetUser && !isNew) {
      (editForm.reset as (values: EditFormValues) => void)({
        email: targetUser.email,
        role: targetUser.role,
        isActive: targetUser.isActive,
      });
    }
  }, [targetUser, editForm, isNew]);

  function invalidateCaches() {
    queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
    queryClient.invalidateQueries({ queryKey: ['adminUser', id] });
  }

  const createMutation = useMutation({
    mutationFn: (values: CreateFormValues) =>
      apiFetch<CreateUserResponse>('/api/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: (result) => {
      invalidateCaches();
      setTempPassword(result.temporaryPassword);
      setCreatedUser(result.user);
    },
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Create failed');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (values: EditFormValues) =>
      apiFetch<{ user: AdminUserView }>(`/api/v1/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      invalidateCaches();
      navigate('/admin/users');
    },
    onError: (err) => {
      setActionError(isApiError(err) ? err.body.message : 'Save failed');
    },
  });

  // Guard: is target the currently logged-in user?
  const isSelf = !!currentUser && !!targetUser && currentUser.id === targetUser.id;

  // Guard: is target the last active Admin?
  const activeAdmins = allUsersData?.items.filter(
    (u) => u.role === 'ADMIN' && u.isActive
  ) ?? [];
  const isLastAdmin =
    !!targetUser &&
    targetUser.role === 'ADMIN' &&
    targetUser.isActive &&
    activeAdmins.length <= 1;

  // Combined disable flag for role/isActive controls
  const guardDisabled = isSelf || isLastAdmin;
  const guardTooltip = isSelf
    ? 'You cannot modify your own account'
    : isLastAdmin
      ? 'Cannot deactivate or demote the last Admin account'
      : undefined;

  function onCreateSubmit(values: CreateFormValues) {
    setActionError(null);
    createMutation.mutate(values);
  }

  function onEditSubmit(values: EditFormValues) {
    setActionError(null);
    updateMutation.mutate(values);
  }

  const isBusy =
    createForm.formState.isSubmitting ||
    editForm.formState.isSubmitting ||
    createMutation.isPending ||
    updateMutation.isPending;

  // Show temp password screen after successful create
  if (tempPassword && createdUser) {
    return (
      <div>
        <div className="admin-page-header">
          <h1 className="admin-page-title">Staff Account Created</h1>
        </div>

        <div className="admin-temp-password-box" role="alert">
          <h2>Temporary password — share this securely</h2>
          <p>
            This password will <strong>never be shown again</strong>. Copy it and share it
            with the new staff member via a secure channel before dismissing this screen.
          </p>
          <p>
            Account: <strong>{createdUser.email}</strong> ({createdUser.role})
          </p>
          <code className="admin-temp-password-value">{tempPassword}</code>
        </div>

        <Button
          variant="primary"
          onClick={() => navigate('/admin/users')}
        >
          Done — I&rsquo;ve copied the password
        </Button>
      </div>
    );
  }

  if (!isNew && targetLoading) {
    return <div className="admin-state">Loading account…</div>;
  }

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">
          {isNew ? 'New Staff Account' : 'Edit Staff Account'}
        </h1>
        <div className="admin-page-actions">
          <Button as="a" href="/admin/users" variant="secondary">
            Back to Accounts
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

      {isNew ? (
        <form
          onSubmit={createForm.handleSubmit(onCreateSubmit)}
          className="admin-form"
          noValidate
        >
          <div className="admin-form-group">
            <FormField
              label="Email"
              htmlFor="user-email"
              errorMessage={createForm.formState.errors.email?.message}
              errorId="user-email-error"
            >
              <input
                id="user-email"
                type="email"
                placeholder="staff@rejuvenate.org"
                aria-invalid={!!createForm.formState.errors.email}
                aria-describedby={createForm.formState.errors.email ? 'user-email-error' : undefined}
                {...createForm.register('email')}
              />
            </FormField>
          </div>

          <div className="admin-form-group">
            <FormField
              label="Role"
              htmlFor="user-role"
              errorMessage={createForm.formState.errors.role?.message}
              errorId="user-role-error"
            >
              <select
                id="user-role"
                aria-invalid={!!createForm.formState.errors.role}
                aria-describedby={createForm.formState.errors.role ? 'user-role-error' : undefined}
                {...createForm.register('role')}
              >
                <option value="ADMIN">Admin</option>
                <option value="BLOGGER">Blogger</option>
                <option value="EVENT_MANAGER">Event Manager</option>
              </select>
            </FormField>
          </div>

          <div className="admin-form-actions">
            <Button type="submit" variant="primary" disabled={isBusy}>
              {createMutation.isPending ? 'Creating…' : 'Create account'}
            </Button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={editForm.handleSubmit(onEditSubmit)}
          className="admin-form"
          noValidate
        >
          <div className="admin-form-group">
            <FormField
              label="Email"
              htmlFor="user-email"
              errorMessage={(errors as typeof editForm.formState.errors).email?.message}
              errorId="user-email-error"
            >
              <input
                id="user-email"
                type="email"
                placeholder="staff@rejuvenate.org"
                aria-invalid={!!(errors as typeof editForm.formState.errors).email}
                aria-describedby={(errors as typeof editForm.formState.errors).email ? 'user-email-error' : undefined}
                {...editForm.register('email')}
              />
            </FormField>
          </div>

          <div className="admin-form-group">
            {guardDisabled && guardTooltip ? (
              <span className="admin-tooltip-wrap">
                <FormField
                  label="Role"
                  htmlFor="user-role"
                  errorMessage={(errors as typeof editForm.formState.errors).role?.message}
                  errorId="user-role-error"
                >
                  <select
                    id="user-role"
                    disabled
                    aria-describedby="user-role-error"
                    {...editForm.register('role')}
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="BLOGGER">Blogger</option>
                    <option value="EVENT_MANAGER">Event Manager</option>
                  </select>
                </FormField>
                <span className="admin-tooltip">{guardTooltip}</span>
              </span>
            ) : (
              <FormField
                label="Role"
                htmlFor="user-role"
                errorMessage={(errors as typeof editForm.formState.errors).role?.message}
                errorId="user-role-error"
              >
                <select
                  id="user-role"
                  aria-invalid={!!(errors as typeof editForm.formState.errors).role}
                  aria-describedby={(errors as typeof editForm.formState.errors).role ? 'user-role-error' : undefined}
                  {...editForm.register('role')}
                >
                  <option value="ADMIN">Admin</option>
                  <option value="BLOGGER">Blogger</option>
                  <option value="EVENT_MANAGER">Event Manager</option>
                </select>
              </FormField>
            )}
          </div>

          <div className="admin-form-group">
            {guardDisabled && guardTooltip ? (
              <span className="admin-tooltip-wrap">
                <label
                  htmlFor="user-active"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: 'not-allowed',
                    color: 'var(--muted)',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                  }}
                >
                  <input
                    id="user-active"
                    type="checkbox"
                    disabled
                    {...editForm.register('isActive')}
                  />
                  Account is active
                </label>
                <span className="admin-tooltip">{guardTooltip}</span>
              </span>
            ) : (
              <label
                htmlFor="user-active"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: 'pointer',
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                }}
              >
                <input
                  id="user-active"
                  type="checkbox"
                  {...editForm.register('isActive')}
                />
                Account is active
              </label>
            )}
            {!targetUser?.isActive && (
              <span className="admin-form-hint" style={{ marginTop: '0.3rem' }}>
                Deactivated accounts cannot log in but are not deleted.
              </span>
            )}
          </div>

          {targetUser && (
            <div
              style={{
                fontSize: '0.82rem',
                color: 'var(--muted)',
                marginBottom: '0.5rem',
                display: 'flex',
                gap: '1.5rem',
                flexWrap: 'wrap',
              }}
            >
              <span>Created: {formatDateTime(targetUser.createdAt)}</span>
              <span>Updated: {formatDateTime(targetUser.updatedAt)}</span>
            </div>
          )}

          <div className="admin-form-actions">
            <Button type="submit" variant="primary" disabled={isBusy}>
              {updateMutation.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
