/**
 * ContactPage — ported from contact.html.
 *
 * Wired in Phase 6:
 * - "Reach Out" card body driven by CmsSlot ('contact.page.details')
 * - Contact form: React Hook Form + Zod validation; submits via mailto:
 *   (plan.md Phase 6 step 4: do NOT invent a ContactMessage backend endpoint).
 *   Shows a success state after submit.
 */
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { z } from 'zod';
import { useCmsSlots } from '@/shared/hooks/useCmsSlots';
import { CmsSlot } from '@/shared/components/CmsSlot';
import { FormField } from '@/design-system/FormField';

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Valid email required'),
  message: z.string().min(1, 'Message is required'),
});

type ContactFormValues = z.infer<typeof contactSchema>;

export function ContactPage() {
  const { slots, isLoading: cmsLoading } = useCmsSlots(['contact.page.details']);
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactSchema),
  });

  function onSubmit(values: ContactFormValues) {
    // mailto: approach — opens the user's mail client with pre-filled fields.
    // Per plan.md Phase 6 step 4: no ContactMessage backend endpoint.
    const subject = encodeURIComponent('Website enquiry');
    const body = encodeURIComponent(
      `Name: ${values.name}\nEmail: ${values.email}\n\n${values.message}`
    );
    // window.open avoids the react-hooks/immutability rule on window.location.href
    window.open(`mailto:hello@rejuvenate.org?subject=${subject}&body=${body}`);
    setSubmitted(true);
  }

  return (
    <main className="inner-page">
      {/* contact.html uses .contact-intro, not .page-hero */}
      <div className="contact-intro">
        <h1>Contact Us</h1>
        <p>We would love to pray with you and answer your questions.</p>
      </div>

      <section className="contact-layout">
        {/* Reach Out card — body driven by CMS slot */}
        <article className="card">
          <h2>Reach Out</h2>
          {cmsLoading ? (
            <div className="loading-placeholder" aria-busy="true" />
          ) : (
            <CmsSlot
              slotKey="contact.page.details"
              slots={slots}
              fallback={
                <>
                  <p style={{ color: 'var(--muted)' }}>Email: hello@rejuvenate.org</p>
                  <p style={{ color: 'var(--muted)' }}>Phone: +27 00 000 0000</p>
                </>
              }
            />
          )}
        </article>

        {submitted ? (
          <div className="card contact-form">
            <h2>Message Sent</h2>
            <p style={{ color: 'var(--muted)' }}>
              Thank you for reaching out! Your email client should have opened with your
              message. We will get back to you as soon as we can.
            </p>
          </div>
        ) : (
          <form
            className="card contact-form"
            onSubmit={handleSubmit(onSubmit)}
            noValidate
          >
            <h2>Send A Message</h2>

            <FormField
              label="Name"
              htmlFor="contact-name"
              errorMessage={errors.name?.message}
              errorId="contact-name-error"
            >
              <input
                id="contact-name"
                type="text"
                placeholder="Your name"
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? 'contact-name-error' : undefined}
                {...register('name')}
              />
            </FormField>

            <FormField
              label="Email"
              htmlFor="contact-email"
              errorMessage={errors.email?.message}
              errorId="contact-email-error"
            >
              <input
                id="contact-email"
                type="email"
                placeholder="you@example.com"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'contact-email-error' : undefined}
                {...register('email')}
              />
            </FormField>

            <FormField
              label="Message"
              htmlFor="contact-message"
              errorMessage={errors.message?.message}
              errorId="contact-message-error"
            >
              <textarea
                id="contact-message"
                rows={5}
                placeholder="How can we help?"
                aria-invalid={!!errors.message}
                aria-describedby={errors.message ? 'contact-message-error' : undefined}
                {...register('message')}
              />
            </FormField>

            <button type="submit">Submit</button>
          </form>
        )}
      </section>
    </main>
  );
}
