/**
 * Login page — /admin/login
 *
 * - Standalone page: no Header / Footer / AdminLayout.
 * - React Hook Form + Zod resolver for validation.
 * - On success: invalidate currentUser query, redirect to state.from or /admin.
 * - On 401/error: single generic message — no account-enumeration hints.
 * - Already-authenticated users are redirected to /admin immediately.
 */
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/shared/api/client';
import { isApiError } from '@/shared/api/errors';
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import { CURRENT_USER_QUERY_KEY } from '@/shared/hooks/useCurrentUser';
import { FormField } from '@/design-system/FormField';
import { Button } from '@/design-system/Button';
import { Brand } from '@/design-system/Brand';
import type { CurrentUser } from '@/shared/types';
import './Login.css';

const loginSchema = z.object({
  email: z.string().email('Valid email required'),
  password: z.string().min(1, 'Required'),
});

type LoginFields = z.infer<typeof loginSchema>;

interface LoginResponse {
  user: CurrentUser;
}

export function Login() {
  const { isAuthenticated, isLoading } = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  // Where to redirect after successful login — honour bookmarked deep links
  const from = (location.state as { from?: Location } | null)?.from?.pathname ?? '/admin';

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginFields>({
    resolver: zodResolver(loginSchema),
  });

  const loginMutation = useMutation({
    mutationFn: (body: LoginFields) =>
      apiFetch<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      // Re-verify identity before redirecting — staleTime:0 ensures a fresh fetch
      await queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY });
      navigate(from, { replace: true });
    },
    onError: (err: unknown) => {
      // Generic message regardless of whether the error is wrong password or
      // no account — mirrors the backend's account-enumeration defense.
      if (isApiError(err) && err.status === 401) {
        setError('root', { message: 'Invalid email or password' });
      } else {
        setError('root', { message: 'Something went wrong. Please try again.' });
      }
    },
  });

  function onSubmit(data: LoginFields) {
    loginMutation.mutate(data);
  }

  // Redirect already-authenticated users away from the login page
  // Wait for the loading state to resolve first to avoid a flash redirect
  useEffect(() => {
    // intentionally empty — handled declaratively below
  }, []);

  if (!isLoading && isAuthenticated) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <Brand className="login-logo" alt="Rejuvenate logo" />
          <span className="login-site-name">Rejuvenate</span>
        </div>

        <h1 className="login-heading">Staff Login</h1>

        <form
          className="login-form"
          onSubmit={handleSubmit(onSubmit)}
          noValidate
        >
          {errors.root?.message && (
            <div className="login-error-banner" role="alert">
              {errors.root.message}
            </div>
          )}

          <FormField
            label="Email"
            htmlFor="login-email"
            errorMessage={errors.email?.message}
            errorId="login-email-error"
          >
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
              {...register('email')}
            />
          </FormField>

          <FormField
            label="Password"
            htmlFor="login-password"
            errorMessage={errors.password?.message}
            errorId="login-password-error"
          >
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'login-password-error' : undefined}
              {...register('password')}
            />
          </FormField>

          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting || loginMutation.isPending}
            className="login-submit"
          >
            {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
