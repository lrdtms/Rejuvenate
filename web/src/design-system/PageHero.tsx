/**
 * PageHero — banner section at the top of inner pages.
 *
 * Props:
 *  variant  — maps to .page-hero-{variant} CSS class; location pages also get
 *             the shared .page-hero-location class (confirmed from cape-town.html:
 *             <section class="page-hero page-hero-location page-hero-cape-town">).
 *  title    — rendered as the single <h1> inside the hero (one h1 per page).
 *  subtitle — optional <p> rendered below the h1, styled in var(--muted).
 *  children — optional additional content rendered after subtitle.
 */
import './PageHero.css';

export type PageHeroVariant = 'about' | 'cape-town' | 'durban' | 'contact' | 'location';

export interface PageHeroProps {
  variant: PageHeroVariant;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}

export function PageHero({ variant, title, subtitle, children }: PageHeroProps) {
  // Location pages (cape-town, durban) get both the shared location class
  // and their specific variant class, matching the legacy markup exactly.
  const isLocation = variant === 'cape-town' || variant === 'durban';

  const classes = [
    'page-hero',
    isLocation ? 'page-hero-location' : null,
    `page-hero-${variant}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={classes}>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {children}
    </section>
  );
}
