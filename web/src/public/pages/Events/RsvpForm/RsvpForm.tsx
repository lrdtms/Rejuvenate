/**
 * RsvpForm — POPIA-compliant registration form for an event.
 *
 * Spec: plan.md Phase 6 step 3 / architecture.md §12.
 *
 * Structure:
 *  1. POPIA consent/privacy notice — shown BEFORE any input fields
 *  2. Form fields: firstName, surname, age, email, phone
 *  3. Hidden honeypot field (invisible to real users, bot trap)
 *  4. Consent checkbox (client-side gate — backend stamps consentVersion)
 *  5. Submit button (disabled while in-flight)
 *
 * Error handling:
 *  400 VALIDATION_ERROR  → field-level errors via setError()
 *  409 CAPACITY_EXCEEDED → top-level message
 *  409 CONFLICT          → top-level message (already registered)
 *  429                   → top-level message (rate limited)
 *
 * PLACEHOLDER CONSENT COPY — pending stakeholder sign-off, see Phase 9.
 * To swap in confirmed wording: update CONSENT_NOTICE.text and bump
 * CONSENT_NOTICE.version. These are the only changes needed.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { apiFetch, isApiError } from '@/shared/api/client';
import { rsvpSchema } from '@/shared/schemas/rsvp.schema';
import type { RsvpFormValues, RsvpFormOutput } from '@/shared/schemas/rsvp.schema';
import { FormField } from '@/design-system/FormField';

// PLACEHOLDER COPY — pending stakeholder sign-off, see Phase 9
const CONSENT_NOTICE = {
  version: 'v1-placeholder',
  text: `Rejuvenate collects your first name, surname, age, email address, and phone number solely
to process your event registration and contact you about this event. Your information will
not be shared with third parties or used for any other purpose without your consent.
You have the right to access, correct, or request deletion of your personal information.
For questions, contact us at hello@rejuvenate.org.`,
};

interface RsvpFormProps {
  slug: string;
  eventTitle: string;
}

interface RegistrationResponse {
  registered: boolean;
}

export function RsvpForm({ slug, eventTitle }: RsvpFormProps) {
  const [topError, setTopError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
    // useForm is typed with both input and output types.
    // RsvpFormValues = input (age: string as read from the number input),
    // RsvpFormOutput = output (age: number after transform).
    // The zodResolver correctly bridges these; the explicit type params prevent
    // the TS error about mismatched input/output generics.
  } = useForm<RsvpFormValues, unknown, RsvpFormOutput>({
    resolver: zodResolver(rsvpSchema) as never,
  });

  const mutation = useMutation<RegistrationResponse, unknown, RsvpFormOutput>({
    mutationFn: (values) => {
      // Strip consentGiven from the POST body — backend does not expect it
      const { consentGiven: _consent, ...body } = values;
      return apiFetch<RegistrationResponse>(`/api/v1/events/${encodeURIComponent(slug)}/registrations`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      setTopError(null);
    },
    onError: (err) => {
      if (!isApiError(err)) {
        setTopError('Something went wrong — please try again.');
        return;
      }

      if (err.status === 400 && err.body.code === 'VALIDATION_ERROR' && err.body.fields) {
        // Map flat field errors directly onto RHF fields
        for (const [field, messages] of Object.entries(err.body.fields)) {
          setError(field as keyof RsvpFormValues, {
            type: 'server',
            message: messages[0],
          });
        }
        setTopError(null);
        return;
      }

      if (err.status === 409) {
        if (err.body.code === 'CAPACITY_EXCEEDED') {
          setTopError('Sorry, this event is now full.');
        } else if (err.body.code === 'CONFLICT') {
          setTopError("It looks like you've already registered for this event.");
        } else {
          setTopError(err.body.message ?? 'Registration could not be completed.');
        }
        return;
      }

      if (err.status === 429) {
        setTopError('Too many attempts — please try again in a few minutes.');
        return;
      }

      setTopError('Something went wrong — please try again.');
    },
  });

  if (mutation.isSuccess) {
    return (
      <div className="rsvp-form-wrapper">
        <div className="rsvp-success" role="status">
          <h3>You are registered!</h3>
          <p style={{ color: 'var(--muted)' }}>
            Thank you for registering for <strong style={{ color: 'var(--text)' }}>{eventTitle}</strong>.
            We look forward to seeing you there. You will hear more from us closer to the event.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rsvp-form-wrapper">
      <h2>Register for this Event</h2>

      {/* POPIA consent/privacy notice — shown BEFORE any input fields
          (architecture.md §12.1.2). Placeholder copy — see Phase 9 comment above. */}
      {/* PLACEHOLDER COPY — pending stakeholder sign-off, see Phase 9 */}
      <div className="rsvp-privacy-notice" role="note" aria-label="Privacy notice">
        <strong>Privacy Notice</strong>
        <p style={{ margin: '0.4rem 0 0', whiteSpace: 'pre-wrap' }}>{CONSENT_NOTICE.text}</p>
      </div>

      {topError && (
        <div className="rsvp-top-error" role="alert">
          {topError}
        </div>
      )}

      <form
        className="rsvp-form"
        onSubmit={handleSubmit((values) => mutation.mutate(values))}
        noValidate
      >
        <FormField
          label="First Name"
          htmlFor="rsvp-firstName"
          errorMessage={errors.firstName?.message}
          errorId="rsvp-firstName-error"
        >
          <input
            id="rsvp-firstName"
            type="text"
            autoComplete="given-name"
            aria-invalid={!!errors.firstName}
            aria-describedby={errors.firstName ? 'rsvp-firstName-error' : undefined}
            {...register('firstName')}
          />
        </FormField>

        <FormField
          label="Surname"
          htmlFor="rsvp-surname"
          errorMessage={errors.surname?.message}
          errorId="rsvp-surname-error"
        >
          <input
            id="rsvp-surname"
            type="text"
            autoComplete="family-name"
            aria-invalid={!!errors.surname}
            aria-describedby={errors.surname ? 'rsvp-surname-error' : undefined}
            {...register('surname')}
          />
        </FormField>

        <FormField
          label="Age"
          htmlFor="rsvp-age"
          errorMessage={errors.age?.message}
          errorId="rsvp-age-error"
        >
          <input
            id="rsvp-age"
            type="number"
            min={0}
            max={120}
            aria-invalid={!!errors.age}
            aria-describedby={errors.age ? 'rsvp-age-error' : undefined}
            {...register('age')}
          />
        </FormField>

        <FormField
          label="Email"
          htmlFor="rsvp-email"
          errorMessage={errors.email?.message}
          errorId="rsvp-email-error"
        >
          <input
            id="rsvp-email"
            type="email"
            autoComplete="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'rsvp-email-error' : undefined}
            {...register('email')}
          />
        </FormField>

        <FormField
          label="Phone"
          htmlFor="rsvp-phone"
          errorMessage={errors.phone?.message}
          errorId="rsvp-phone-error"
        >
          <input
            id="rsvp-phone"
            type="tel"
            autoComplete="tel"
            aria-invalid={!!errors.phone}
            aria-describedby={errors.phone ? 'rsvp-phone-error' : undefined}
            {...register('phone')}
          />
        </FormField>

        {/* Hidden honeypot — must be in the DOM but invisible to real users.
            A filled honeypot field signals a bot; the server checks and rejects. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ display: 'none' }}
          {...register('honeypot')}
        />

        {/* Consent checkbox — required client-side gate (architecture.md §12.1.2).
            Backend stamps consentVersion server-side; this checkbox is UX only. */}
        <div>
          <div className="rsvp-consent-row">
            <input
              id="rsvp-consent"
              type="checkbox"
              aria-invalid={!!errors.consentGiven}
              aria-describedby={errors.consentGiven ? 'rsvp-consent-error' : undefined}
              {...register('consentGiven')}
            />
            <label htmlFor="rsvp-consent" style={{ fontWeight: 400, fontSize: '0.9rem', cursor: 'pointer' }}>
              I have read and agree to the above privacy notice
            </label>
          </div>
          {errors.consentGiven && (
            <span
              id="rsvp-consent-error"
              role="alert"
              style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.85rem', color: '#ff6b6b' }}
            >
              {errors.consentGiven.message}
            </span>
          )}
        </div>

        <button
          type="submit"
          disabled={mutation.isPending}
          style={{
            marginTop: '0.5rem',
            border: 0,
            borderRadius: 12,
            padding: '0.75rem 1.25rem',
            font: 'inherit',
            fontWeight: 800,
            color: '#00101a',
            background: mutation.isPending
              ? 'rgba(91,231,255,0.5)'
              : 'linear-gradient(110deg, #5be7ff, #9ef2ff)',
            cursor: mutation.isPending ? 'not-allowed' : 'pointer',
          }}
          aria-disabled={mutation.isPending}
        >
          {mutation.isPending ? 'Registering…' : 'Register'}
        </button>
      </form>
    </div>
  );
}
