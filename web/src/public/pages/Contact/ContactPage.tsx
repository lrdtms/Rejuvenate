/**
 * ContactPage — ported from contact.html.
 *
 * Note on the contact form: the legacy HTML has action="#" (no backend handler).
 * Per plan.md Phase 6 step 4, we do NOT invent a ContactMessage backend endpoint.
 * The form here uses mailto: as the interim approach — it opens the user's mail
 * client with pre-filled subject/body. This is replaced by a proper solution in
 * Phase 6 once the PRD approach is confirmed.
 *
 * The "Reach Out" card body will be replaced by:
 *   <CmsSlot slotKey="contact.page.details" /> in Phase 6.
 *
 * Contact page uses .contact-intro (plain centered h1/p, no hero banner) —
 * confirmed from contact.html markup.
 */

export function ContactPage() {
  return (
    <main className="inner-page">
      {/* contact.html uses .contact-intro, not .page-hero */}
      <div className="contact-intro">
        <h1>Contact Us</h1>
        <p>We would love to pray with you and answer your questions.</p>
      </div>

      <section className="contact-layout">
        {/* Phase 6: replace body with <CmsSlot slotKey="contact.page.details" /> */}
        <article className="card">
          <h2>Reach Out</h2>
          <p>Email: hello@rejuvenate.org</p>
          <p>Phone: +27 00 000 0000</p>
          <p>Replace these placeholders with your official details.</p>
        </article>

        <form
          className="card contact-form"
          action={`mailto:hello@rejuvenate.org?subject=Website enquiry`}
          method="get"
          encType="text/plain"
        >
          <h2>Send A Message</h2>

          <label htmlFor="contact-name">Name</label>
          <input id="contact-name" name="name" type="text" placeholder="Your name" required />

          <label htmlFor="contact-email">Email</label>
          <input
            id="contact-email"
            name="email"
            type="email"
            placeholder="you@example.com"
            required
          />

          <label htmlFor="contact-message">Message</label>
          <textarea
            id="contact-message"
            name="body"
            rows={5}
            placeholder="How can we help?"
          />

          <button type="submit">Submit</button>
        </form>
      </section>
    </main>
  );
}
