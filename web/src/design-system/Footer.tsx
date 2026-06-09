/**
 * Footer — minimal branded footer.
 * The legacy static site had no explicit footer element; this provides the
 * structural complement to the Header using the same token palette.
 */
import './Footer.css';

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <span>&copy; {year} Rejuvenate. All rights reserved.</span>
      <nav aria-label="Footer navigation">
        <a href="mailto:hello@rejuvenate.org">hello@rejuvenate.org</a>
      </nav>
    </footer>
  );
}
