/**
 * AdminLayout — persistent sidebar (desktop) / top nav (mobile) shell
 * for all authenticated admin routes.
 *
 * Features:
 * - Brand logo in sidebar/topbar
 * - Nav items from adminNavItems, filtered by current user's role
 * - NavLink active state (react-router-dom automatic `active` class)
 * - Current user email + role badge
 * - Logout action: POST /auth/logout → clear query cache → navigate to login
 * - Responsive: sidebar at >820px, collapsible topbar at ≤820px
 * - AccessDeniedProvider wraps the outlet so RoleGuard can set flash messages
 */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/shared/api/client';
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import { useHasRole } from '@/admin/components/RoleGuard';
import { AccessDeniedProvider } from '@/admin/components/AccessDeniedContext';
import { adminNavItems } from '@/admin/config/navConfig';
import type { AdminRole } from '@/admin/config/navConfig';
import { Brand } from '@/design-system/Brand';
import { Button } from '@/design-system/Button';
import './AdminLayout.css';

export function AdminLayout() {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const logoutMutation = useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/v1/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Clear ALL cached queries (including currentUser) so stale state
      // never leaks to the next session
      queryClient.clear();
      navigate('/admin/login', { replace: true });
    },
  });

  function handleLogout() {
    logoutMutation.mutate();
  }

  // Filter nav items to only those the current user's role can see
  const visibleNavItems = adminNavItems.filter((item) =>
    user ? item.allowedRoles.includes(user.role as AdminRole) : false,
  );

  // Role badge display
  const roleBadge: Record<AdminRole, string> = {
    ADMIN: 'Admin',
    BLOGGER: 'Blogger',
    EVENT_MANAGER: 'Event Manager',
  };

  const canSeeNav = useHasRole('ADMIN', 'BLOGGER', 'EVENT_MANAGER');

  return (
    <div className="admin-shell">
      {/* Sidebar — desktop */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <NavLink to="/admin" className="admin-brand-link">
            <Brand className="admin-logo" alt="Rejuvenate logo" />
            <span className="admin-brand-name">Rejuvenate</span>
          </NavLink>
        </div>

        {canSeeNav && (
          <nav className="admin-nav" aria-label="Admin navigation">
            <ul className="admin-nav-list">
              {visibleNavItems.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/admin'}
                    className={({ isActive }) =>
                      ['admin-nav-link', isActive ? 'active' : ''].filter(Boolean).join(' ')
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="admin-sidebar-footer">
          {user && (
            <div className="admin-user-info">
              <span className="admin-user-email" title={user.email}>
                {user.email}
              </span>
              <span className="admin-role-badge">
                {roleBadge[user.role as AdminRole] ?? user.role}
              </span>
            </div>
          )}
          <Button
            variant="secondary"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="admin-logout-btn"
          >
            {logoutMutation.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </aside>

      {/* Mobile topbar */}
      <div className="admin-topbar">
        <NavLink to="/admin" className="admin-brand-link admin-topbar-brand">
          <Brand className="admin-logo" alt="Rejuvenate logo" />
          <span className="admin-brand-name">Rejuvenate</span>
        </NavLink>

        <button
          className="admin-mobile-toggle"
          type="button"
          aria-expanded={mobileNavOpen}
          aria-controls="admin-mobile-nav"
          aria-label="Toggle admin navigation"
          onClick={() => setMobileNavOpen((prev) => !prev)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {/* Mobile nav drawer */}
      {mobileNavOpen && (
        <div
          id="admin-mobile-nav"
          className="admin-mobile-nav"
          onClick={() => setMobileNavOpen(false)}
        >
          {canSeeNav && (
            <nav aria-label="Admin navigation">
              <ul className="admin-nav-list">
                {visibleNavItems.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/admin'}
                      className={({ isActive }) =>
                        ['admin-nav-link', isActive ? 'active' : ''].filter(Boolean).join(' ')
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {user && (
            <div className="admin-user-info admin-mobile-user">
              <span className="admin-user-email">{user.email}</span>
              <span className="admin-role-badge">
                {roleBadge[user.role as AdminRole] ?? user.role}
              </span>
            </div>
          )}
          <Button
            variant="secondary"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="admin-logout-btn"
          >
            {logoutMutation.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      )}

      {/* Main content */}
      <main className="admin-main">
        <AccessDeniedProvider>
          <Outlet />
        </AccessDeniedProvider>
      </main>
    </div>
  );
}
