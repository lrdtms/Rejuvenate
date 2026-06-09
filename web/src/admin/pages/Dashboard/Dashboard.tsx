/**
 * Dashboard — the admin landing page.
 *
 * Keeps it simple per plan.md: no analytics, just practical quick links
 * and one-number summaries for roles that can see them.
 *
 * Summary cards:
 * - "Total posts" (ADMIN + BLOGGER) — GET /blog/posts?limit=1 → total
 * - "Upcoming events" (ADMIN + EVENT_MANAGER) — GET /events?temporal=upcoming&limit=1 → total + nearest date
 *
 * Quick-action links are filtered by role via adminNavItems (no duplicate matrix).
 *
 * AccessDenied banner: shown if RoleGuard set a message (e.g., user tried to
 * navigate to a route their role can't access). Clears on dismiss.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiFetch } from '@/shared/api/client';
import { useCurrentUser } from '@/shared/hooks/useCurrentUser';
import { useHasRole } from '@/admin/components/useHasRole';
import { useAccessDenied } from '@/admin/components/AccessDeniedContext';
import { adminNavItems } from '@/admin/config/navConfig';
import type { AdminRole } from '@/admin/config/navConfig';
import type { BlogPostsPage } from '@/shared/types';
import type { EventsPage } from '@/shared/types';
import { formatDateTime } from '@/shared/utils/formatDate';
import './Dashboard.css';

export function Dashboard() {
  const { user } = useCurrentUser();
  const { message: accessDeniedMessage, setMessage: clearAccessDenied } = useAccessDenied();

  const canSeeBlog = useHasRole('ADMIN', 'BLOGGER');
  const canSeeEvents = useHasRole('ADMIN', 'EVENT_MANAGER');

  // Summary: total posts (ADMIN + BLOGGER only)
  const { data: postsData } = useQuery<BlogPostsPage>({
    queryKey: ['dashboard', 'posts-count'],
    queryFn: () => apiFetch<BlogPostsPage>('/api/v1/blog/posts?limit=1'),
    enabled: canSeeBlog,
    staleTime: 60 * 1000,
  });

  // Summary: upcoming events count + nearest date (ADMIN + EVENT_MANAGER only)
  const { data: eventsData } = useQuery<EventsPage>({
    queryKey: ['dashboard', 'upcoming-events'],
    queryFn: () => apiFetch<EventsPage>('/api/v1/events?temporal=upcoming&limit=1'),
    enabled: canSeeEvents,
    staleTime: 60 * 1000,
  });

  // Quick-action links: filter adminNavItems by the current user's role,
  // then exclude Dashboard itself (index route — not a useful "quick action")
  const quickLinks = adminNavItems.filter(
    (item) =>
      item.to !== '/admin' &&
      (user ? item.allowedRoles.includes(user.role as AdminRole) : false),
  );

  const nearestEventDate =
    eventsData?.items?.[0]?.startsAt
      ? formatDateTime(eventsData.items[0].startsAt)
      : null;

  return (
    <div className="dashboard">
      {/* Access-denied flash banner */}
      {accessDeniedMessage && (
        <div className="dashboard-access-denied" role="alert">
          <span>{accessDeniedMessage}</span>
          <button
            type="button"
            className="dashboard-access-denied-dismiss"
            aria-label="Dismiss"
            onClick={() => clearAccessDenied(null)}
          >
            &times;
          </button>
        </div>
      )}

      <h1 className="dashboard-heading">Dashboard</h1>

      {user && (
        <p className="dashboard-greeting">
          Welcome back, <strong>{user.email}</strong>
          <span className="dashboard-role-tag">
            {user.role === 'EVENT_MANAGER' ? 'Event Manager' : user.role.charAt(0) + user.role.slice(1).toLowerCase()}
          </span>
        </p>
      )}

      {/* Summary cards */}
      {(canSeeBlog || canSeeEvents) && (
        <section className="dashboard-summary" aria-label="Summary">
          {canSeeBlog && (
            <div className="dashboard-summary-card">
              <span className="dashboard-summary-label">Total posts</span>
              <span className="dashboard-summary-value">
                {postsData !== undefined ? postsData.total : '—'}
              </span>
            </div>
          )}

          {canSeeEvents && (
            <div className="dashboard-summary-card">
              <span className="dashboard-summary-label">Upcoming events</span>
              <span className="dashboard-summary-value">
                {eventsData !== undefined ? eventsData.total : '—'}
              </span>
              {nearestEventDate && (
                <span className="dashboard-summary-sub">Next: {nearestEventDate}</span>
              )}
            </div>
          )}
        </section>
      )}

      {/* Quick-action links */}
      {quickLinks.length > 0 && (
        <section className="dashboard-quicklinks" aria-label="Quick actions">
          <h2 className="dashboard-section-heading">Quick actions</h2>
          <ul className="dashboard-quicklinks-list">
            {quickLinks.map((item) => (
              <li key={item.to}>
                <Link to={item.to} className="dashboard-quicklink">
                  {item.label === 'Blog' && 'Manage Blog'}
                  {item.label === 'Events' && 'Manage Events'}
                  {item.label === 'CMS' && 'Edit CMS'}
                  {item.label === 'Users' && 'Manage Users'}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
