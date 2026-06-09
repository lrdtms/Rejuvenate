/**
 * DurbanPage — ported from durban.html.
 *
 * The static Quicket event-card block has been intentionally dropped per
 * architecture.md §14 + plan.md Phase 5 note. A placeholder link to /events
 * is shown in its place until Phase 6 step 3 wires up the live Events widget.
 *
 * The location-contact-card body will be replaced by:
 *   <CmsSlot slotKey="contact.durban.card" /> in Phase 6.
 */
import { Link } from 'react-router-dom';
import { PageHero } from '@/design-system/PageHero';
import { Card } from '@/design-system/Card';

export function DurbanPage() {
  return (
    <main className="inner-page">
      <PageHero
        variant="durban"
        title="Durban"
        subtitle="Worship, community, and renewal on the coast."
      />

      <section className="content-grid location-content-grid">
        {/* Quicket event-card dropped — see Phase 5 plan note / architecture.md §14.
            Phase 6 step 3 will add a live Events widget here filtered by Durban. */}
        <Card>
          <h2>Upcoming Events</h2>
          <p>
            See our <Link to="/events">Events page</Link> for upcoming gatherings.
          </p>
        </Card>

        {/* Phase 6: replace body with <CmsSlot slotKey="contact.durban.card" /> */}
        <Card variant="location-contact">
          <h2>Local Contact</h2>
          <p>durban@rejuvenate.org</p>
          <p>Add team contacts and new visitor information here.</p>
        </Card>
      </section>
    </main>
  );
}
