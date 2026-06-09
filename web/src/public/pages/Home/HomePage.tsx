/**
 * HomePage — ported from index.html.
 * Full-bleed hero with overlay, "JOIN THE MOVEMENT" headline, and
 * the Matthew 18:20 verse block.
 * The page-home body class enables the viewport-height overflow clipping
 * on desktop (see global.css body.page-home media query).
 */
import { useEffect } from 'react';

export function HomePage() {
  // Apply body class for the full-bleed home hero behaviour
  useEffect(() => {
    document.body.classList.add('page-home');
    return () => {
      document.body.classList.remove('page-home');
    };
  }, []);

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
        </div>
      </section>
    </main>
  );
}
