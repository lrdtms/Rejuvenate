/**
 * RsvpForm — stub placeholder.
 * The full POPIA-compliant RSVP form (first name, surname, age, email, phone,
 * consent checkbox) is built in Phase 6 step 3.
 *
 * This stub is here so EventDetailPage has a target to import from.
 * It will be replaced entirely in Phase 6 — do not build logic here.
 */
export function RsvpForm() {
  return (
    <aside>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
        RSVP form — wired to POST /api/v1/events/:slug/registrations in Phase 6.
      </p>
    </aside>
  );
}
