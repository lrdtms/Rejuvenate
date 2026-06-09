/**
 * HomePage — ported from index.html.
 * Full-bleed hero with overlay, "JOIN THE MOVEMENT" headline, and
 * the Matthew 18:20 verse block.
 *
 * Phase 6: short "upcoming events" and "latest posts" preview strips
 * below the hero, each showing up to 2 items.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useEvents } from '@/shared/hooks/useEvents';
import { useBlogPosts } from '@/shared/hooks/useBlogPosts';
import { formatEventDateRange, formatDateTime } from '@/shared/utils/formatDate';

export function HomePage() {
  // Apply body class for the full-bleed home hero behaviour
  useEffect(() => {
    document.body.classList.add('page-home');
    return () => {
      document.body.classList.remove('page-home');
    };
  }, []);

  const { data: eventsData } = useEvents({ temporal: 'upcoming', limit: 2 });
  const { data: postsData } = useBlogPosts({ limit: 2 });

  return (
    <main>
      <section className="hero" aria-label="Hero banner">
        <div className="hero-overlay" />
        <div className="hero-content">
          <h1>JOIN THE MOVEMENT</h1>
          <div className="verse-block">
            <h2>Matthew 18:20</h2>
            <p>&ldquo;For where two or three gather in my name, there am I with them.&rdquo;</p>
          </div>

          {/* Preview strips — shown below the verse block on larger viewports;
              on the home page the hero takes full viewport height so these
              will be accessible on scroll. */}
          <div className="home-preview-strips">
            {eventsData && eventsData.items.length > 0 && (
              <section className="home-preview-strip" aria-label="Upcoming events">
                <h3>
                  <Link to="/events">Upcoming Events</Link>
                </h3>
                <ul>
                  {eventsData.items.map((event) => (
                    <li key={event.id}>
                      <Link to={`/events/${event.slug}`}>{event.title}</Link>
                      <span>{formatEventDateRange(event.startsAt, event.endsAt)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {postsData && postsData.items.length > 0 && (
              <section className="home-preview-strip" aria-label="Latest posts">
                <h3>
                  <Link to="/blog">Latest Posts</Link>
                </h3>
                <ul>
                  {postsData.items.map((post) => (
                    <li key={post.id}>
                      <Link to={`/blog/${post.slug}`}>{post.title}</Link>
                      <span>{formatDateTime(post.publishedAt)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
