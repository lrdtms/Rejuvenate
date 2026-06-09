/**
 * AboutPage — ported from about.html.
 *
 * Card bodies are driven by CMS slots fetched via useCmsSlots().
 * The card chrome (headings, Card component, layout grid) is
 * code-controlled and never editable via CMS (architecture.md §9.5).
 * CmsSlot supplies only the text content within each card.
 */
import { PageHero } from '@/design-system/PageHero';
import { Card } from '@/design-system/Card';
import { useCmsSlots } from '@/shared/hooks/useCmsSlots';
import { CmsSlot } from '@/shared/components/CmsSlot';

const CMS_KEYS = [
  'about.card.who-are-we',
  'about.card.what-we-do',
  'about.card.get-involved',
] as const;

export function AboutPage() {
  const { slots, isLoading, error } = useCmsSlots([...CMS_KEYS]);

  if (error) {
    return (
      <main className="inner-page">
        <PageHero
          variant="about"
          title="About Rejuvenate"
          subtitle="A community centered on worship, renewal, and belonging."
        />
        <section className="content-grid about-content-grid">
          <p style={{ color: 'var(--muted)', gridColumn: 'span 12' }}>
            Something went wrong — please try again.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="inner-page">
      <PageHero
        variant="about"
        title="About Rejuvenate"
        subtitle="A community centered on worship, renewal, and belonging."
      />

      <section className="content-grid about-content-grid">
        {/* Card chrome (heading + Card wrapper) is code-controlled;
            CmsSlot supplies only the body text. While loading, the
            headings remain visible — only the slot content is absent. */}
        <Card>
          <h2>Who are we?</h2>
          {isLoading ? (
            <div className="loading-placeholder" aria-busy="true" />
          ) : (
            <CmsSlot
              slotKey="about.card.who-are-we"
              slots={slots}
              fallback={<p style={{ color: 'var(--muted)' }}>Content coming soon.</p>}
            />
          )}
        </Card>

        <Card>
          <h2>What do we do?</h2>
          {isLoading ? (
            <div className="loading-placeholder" aria-busy="true" />
          ) : (
            <CmsSlot
              slotKey="about.card.what-we-do"
              slots={slots}
              fallback={<p style={{ color: 'var(--muted)' }}>Content coming soon.</p>}
            />
          )}
        </Card>

        <Card>
          <h2>Get Involved</h2>
          {isLoading ? (
            <div className="loading-placeholder" aria-busy="true" />
          ) : (
            <CmsSlot
              slotKey="about.card.get-involved"
              slots={slots}
              fallback={<p style={{ color: 'var(--muted)' }}>Content coming soon.</p>}
            />
          )}
        </Card>
      </section>
    </main>
  );
}
