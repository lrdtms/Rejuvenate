/**
 * Admin-specific types — shapes returned by admin-only API endpoints.
 * These are separate from the public types to keep the shared/ boundary clean.
 */

/** Full blog post shape including admin-only fields */
export interface AdminBlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  status: 'DRAFT' | 'PUBLISHED';
  publishedAt: string | null;
  author: {
    id: string;
    email: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AdminBlogPostsPage {
  items: AdminBlogPost[];
  page: number;
  limit: number;
  total: number;
  pageCount: number;
}

/** Full event shape including admin-only fields */
export interface AdminEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  branch: 'CAPE_TOWN' | 'DURBAN';
  status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
  startsAt: string;
  endsAt: string | null;
  locationDetail: string | null;
  capacity: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminEventsPage {
  items: AdminEvent[];
  page: number;
  limit: number;
  total: number;
  pageCount: number;
}

/** Registration shape returned by GET /api/v1/admin/events/:id/registrations */
export interface Registration {
  id: string;
  firstName: string;
  surname: string;
  age: number;
  email: string;
  phone: string;
  registeredAt: string;
  consentVersion: string;
}

export interface RegistrationsPage {
  items: Registration[];
  total: number;
  page: number;
  limit: number;
  pageCount: number;
}

/** CMS slot shape from admin endpoint */
export interface AdminCmsSlot {
  slotKey: string;
  format: 'PLAIN_TEXT' | 'RICH_TEXT';
  value: string;
  updatedAt: string | null;
}

/** Media asset shape */
export interface MediaAsset {
  id: string;
  url: string;
  altText: string | null;
  ownerType: 'BLOG_POST' | 'EVENT';
  ownerId: string;
  sizeBytes: number;
  mimeType: string;
  displaySize: 'small' | 'medium' | 'full';
  createdAt: string;
}

/** Admin user view — no passwordHash */
export interface AdminUserView {
  id: string;
  email: string;
  role: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUsersResponse {
  items: AdminUserView[];
}

export interface CreateUserResponse {
  user: AdminUserView;
  temporaryPassword: string;
}
