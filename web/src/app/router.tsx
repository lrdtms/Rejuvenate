/**
 * Router — element-based <Routes> tree (not data-router / createBrowserRouter).
 * Per plan.md YAGNI note: simple <Routes> is preferred over loaders/actions
 * unless a concrete need emerges.
 *
 * Route tree:
 *   /             → HomePage
 *   /about        → AboutPage
 *   /cape-town    → CapeTownPage
 *   /durban       → DurbanPage
 *   /contact      → ContactPage
 *   /blog         → BlogListPage
 *   /blog/:slug   → BlogPostPage
 *   /events       → EventsPage
 *   /events/:slug → EventDetailPage
 *   /admin/login  → Login (standalone, no auth required)
 *   /admin/*      → Admin route tree (RequireAuth → AdminLayout → pages)
 *   *             → NotFoundPage
 *
 * All public routes are wrapped in <Layout> (Header + Outlet + Footer).
 * Admin routes have their own layout shell (AdminLayout) — no Header/Footer.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './Layout';

// Public pages
import { HomePage } from '@/public/pages/Home/HomePage';
import { AboutPage } from '@/public/pages/About/AboutPage';
import { CapeTownPage } from '@/public/pages/CapeTown/CapeTownPage';
import { DurbanPage } from '@/public/pages/Durban/DurbanPage';
import { ContactPage } from '@/public/pages/Contact/ContactPage';
import { BlogListPage } from '@/public/pages/Blog/BlogIndex/BlogListPage';
import { BlogPostPage } from '@/public/pages/Blog/BlogPostDetail/BlogPostPage';
import { EventsPage } from '@/public/pages/Events/EventsIndex/EventsPage';
import { EventDetailPage } from '@/public/pages/Events/EventDetail/EventDetailPage';
import { NotFoundPage } from '@/public/pages/NotFound/NotFoundPage';

// Admin auth + shell
import { Login } from '@/admin/pages/Login/Login';
import { RequireAuth } from '@/admin/components/RequireAuth';
import { RoleGuard } from '@/admin/components/RoleGuard';
import { AdminLayout } from '@/admin/layout/AdminLayout';

// Admin pages
import { Dashboard } from '@/admin/pages/Dashboard/Dashboard';
import { PostList } from '@/admin/pages/Blog/PostList/PostList';
import { PostEditor } from '@/admin/pages/Blog/PostEditor/PostEditor';
import { EventList } from '@/admin/pages/Events/EventList/EventList';
import { EventEditor } from '@/admin/pages/Events/EventEditor/EventEditor';
import { RegistrationsView } from '@/admin/pages/Events/RegistrationsView/RegistrationsView';
import { SlotEditor } from '@/admin/pages/Cms/SlotEditor/SlotEditor';
import { StaffAccountList } from '@/admin/pages/Users/StaffAccountList/StaffAccountList';
import { StaffAccountEditor } from '@/admin/pages/Users/StaffAccountEditor/StaffAccountEditor';

export function Router() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public route tree — all wrapped in shared Layout */}
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="cape-town" element={<CapeTownPage />} />
          <Route path="durban" element={<DurbanPage />} />
          <Route path="contact" element={<ContactPage />} />
          <Route path="blog" element={<BlogListPage />} />
          <Route path="blog/:slug" element={<BlogPostPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="events/:slug" element={<EventDetailPage />} />
          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* Admin login — standalone, no RequireAuth, no AdminLayout */}
        <Route path="admin/login" element={<Login />} />

        {/* Admin route tree — RequireAuth gates the whole subtree */}
        <Route path="admin/*" element={<RequireAuth />}>
          <Route element={<AdminLayout />}>
            {/* Dashboard — index route */}
            <Route index element={<Dashboard />} />

            {/* Blog — ADMIN + BLOGGER */}
            <Route
              path="blog"
              element={
                <RoleGuard allow={['ADMIN', 'BLOGGER']}>
                  <PostList />
                </RoleGuard>
              }
            />
            <Route
              path="blog/new"
              element={
                <RoleGuard allow={['ADMIN', 'BLOGGER']}>
                  <PostEditor />
                </RoleGuard>
              }
            />
            <Route
              path="blog/:id/edit"
              element={
                <RoleGuard allow={['ADMIN', 'BLOGGER']}>
                  <PostEditor />
                </RoleGuard>
              }
            />

            {/* Events — ADMIN + EVENT_MANAGER */}
            <Route
              path="events"
              element={
                <RoleGuard allow={['ADMIN', 'EVENT_MANAGER']}>
                  <EventList />
                </RoleGuard>
              }
            />
            <Route
              path="events/new"
              element={
                <RoleGuard allow={['ADMIN', 'EVENT_MANAGER']}>
                  <EventEditor />
                </RoleGuard>
              }
            />
            <Route
              path="events/:id/edit"
              element={
                <RoleGuard allow={['ADMIN', 'EVENT_MANAGER']}>
                  <EventEditor />
                </RoleGuard>
              }
            />
            <Route
              path="events/:id/registrations"
              element={
                <RoleGuard allow={['ADMIN', 'EVENT_MANAGER']}>
                  <RegistrationsView />
                </RoleGuard>
              }
            />

            {/* CMS — ADMIN only */}
            <Route
              path="cms"
              element={
                <RoleGuard allow={['ADMIN']}>
                  <SlotEditor />
                </RoleGuard>
              }
            />

            {/* Users — ADMIN only */}
            <Route
              path="users"
              element={
                <RoleGuard allow={['ADMIN']}>
                  <StaffAccountList />
                </RoleGuard>
              }
            />
            <Route
              path="users/new"
              element={
                <RoleGuard allow={['ADMIN']}>
                  <StaffAccountEditor />
                </RoleGuard>
              }
            />
            <Route
              path="users/:id/edit"
              element={
                <RoleGuard allow={['ADMIN']}>
                  <StaffAccountEditor />
                </RoleGuard>
              }
            />

            {/* Unknown admin routes → Dashboard */}
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
