/**
 * CurrentUser — the shape returned by GET /api/v1/me.
 * This is the single source of truth for the authenticated user's
 * identity and role throughout the admin area.
 */
export interface CurrentUser {
  id: string;
  email: string;
  role: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
  isActive: boolean;
}
