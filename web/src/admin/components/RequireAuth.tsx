/**
 * RequireAuth — wraps all /admin/* routes (except /admin/login).
 *
 * While the current-user query is loading: render a neutral loading state.
 * The loading state is deliberately not the login page and not protected
 * content — it is the safe "indeterminate" UI that avoids flashing either.
 *
 * If unauthenticated (and not loading): redirect to /admin/login, preserving
 * the original location in state.from so post-login redirect works.
 *
 * If authenticated: render <Outlet /> (the admin layout + page).
 *
 * This is UX-only redirection — not a security boundary. The server
 * independently re-checks every request via requireAuth() middleware.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import './RequireAuth.css';

export function RequireAuth() {
  const { user, isLoading, isAuthenticated } = useCurrentUser();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="require-auth-loading" aria-live="polite" aria-busy="true">
        <span className="require-auth-spinner" aria-hidden="true" />
        <span className="require-auth-loading-text">Loading…</span>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/admin/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
