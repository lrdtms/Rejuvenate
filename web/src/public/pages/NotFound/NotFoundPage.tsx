/**
 * NotFoundPage — 404 catch-all route.
 */
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="inner-page" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
      <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 'clamp(2rem,4vw,3.2rem)' }}>
        Page Not Found
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        The page you are looking for does not exist.
      </p>
      <Link
        to="/"
        style={{
          color: 'var(--accent)',
          textDecoration: 'underline',
          textUnderlineOffset: '0.25em',
        }}
      >
        Return home
      </Link>
    </main>
  );
}
