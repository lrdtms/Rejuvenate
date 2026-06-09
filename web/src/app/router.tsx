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
 *   /admin/*      → Admin placeholder (Phase 7)
 *   *             → NotFoundPage
 *
 * All public routes are wrapped in <Layout> (Header + Outlet + Footer).
 */
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './Layout';

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

        {/* Admin route tree — Phase 7 will replace this placeholder */}
        <Route path="admin/*" element={<div>Admin &mdash; coming soon</div>} />
      </Routes>
    </BrowserRouter>
  );
}
