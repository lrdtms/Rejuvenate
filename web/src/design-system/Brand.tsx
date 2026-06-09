/**
 * Brand — logo component. Renders the SVG logo from src/assets/.
 * Used inside Header directly as an <img> to match the legacy markup exactly.
 * Exported here as a standalone component for any other consumer that needs
 * just the logo (e.g., admin layout, print views).
 */
import logoSrc from '../assets/rejuvenateLogo.svg';

export interface BrandProps {
  /** CSS class applied to the <img> element */
  className?: string;
  /** Alt text — defaults to "Rejuvenate logo" */
  alt?: string;
}

export function Brand({ className = 'brand-logo', alt = 'Rejuvenate logo' }: BrandProps) {
  return <img className={className} src={logoSrc} alt={alt} />;
}
