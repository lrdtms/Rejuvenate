/**
 * AboutPage — ported from about.html (including the pre-existing uncommitted
 * change: headings read "Who are we?" / "What do we do?" / "Get involved").
 *
 * Card bodies are placeholder text that will be replaced by CMS-slot content
 * in Phase 6 (slots: about.card.who-are-we, about.card.what-we-do,
 * about.card.get-involved).
 */
import { PageHero } from '@/design-system/PageHero';
import { Card } from '@/design-system/Card';

export function AboutPage() {
  return (
    <main className="inner-page">
      <PageHero
        variant="about"
        title="About Rejuvenate"
        subtitle="A community centered on worship, renewal, and belonging."
      />

      <section className="content-grid about-content-grid">
        {/* Phase 6: replace card bodies with <CmsSlot slotKey="about.card.who-are-we" /> */}
        <Card>
          <h2>Who are we?</h2>
          <p>
            We gather for worship, scripture, and practical support throughout the week. This
            section is ready for your final ministry schedule and values.
          </p>
        </Card>

        {/* Phase 6: replace with <CmsSlot slotKey="about.card.what-we-do" /> */}
        <Card>
          <h2>What do we do?</h2>
          <p>
            Warm welcomes, authentic worship, and room to grow. Replace this with your ministry
            voice, service format, and newcomer guidance.
          </p>
        </Card>

        {/* Phase 6: replace with <CmsSlot slotKey="about.card.get-involved" /> */}
        <Card>
          <h2>Get Involved</h2>
          <p>
            Join a serving team, small group, or prayer circle. Add your real onboarding steps and
            leadership contacts here when ready.
          </p>
        </Card>
      </section>
    </main>
  );
}
