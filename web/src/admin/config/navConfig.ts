/**
 * adminNavConfig — single source of truth for the RBAC matrix.
 *
 * The nav renderer, route-gating (RoleGuard), and any "do I have access"
 * checks all read from this array. There are no scattered per-route role
 * conditionals elsewhere.
 *
 * Mirrors architecture.md §9.2 RBAC matrix:
 *   ADMIN        — Dashboard, Blog, Events, CMS, Users
 *   BLOGGER      — Dashboard, Blog
 *   EVENT_MANAGER — Dashboard, Events
 */
export type AdminRole = 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';

export interface NavItem {
  label: string;
  to: string;
  allowedRoles: AdminRole[];
}

export const adminNavItems: NavItem[] = [
  {
    label: 'Dashboard',
    to: '/admin',
    allowedRoles: ['ADMIN', 'BLOGGER', 'EVENT_MANAGER'],
  },
  {
    label: 'Blog',
    to: '/admin/blog',
    allowedRoles: ['ADMIN', 'BLOGGER'],
  },
  {
    label: 'Events',
    to: '/admin/events',
    allowedRoles: ['ADMIN', 'EVENT_MANAGER'],
  },
  {
    label: 'CMS',
    to: '/admin/cms',
    allowedRoles: ['ADMIN'],
  },
  {
    label: 'Users',
    to: '/admin/users',
    allowedRoles: ['ADMIN'],
  },
];
