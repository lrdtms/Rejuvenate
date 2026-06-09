/**
 * Event — shape returned by GET /api/v1/events and
 * GET /api/v1/events/:slug.
 *
 * isPaid / priceCents are deliberately excluded — dormant per ADR-0006;
 * do not render payment-related UI on public pages.
 */
export interface Event {
  id: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string | null;
  branch: 'CAPE_TOWN' | 'DURBAN';
  status: string;
  capacity: number | null;
  images: { id: string; url: string; altText: string | null; displaySize: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface EventsPage {
  items: Event[];
  page: number;
  limit: number;
  total: number;
  pageCount: number;
}
