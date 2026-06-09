/**
 * rsvpSchema — Zod schema for the RSVP registration form.
 *
 * Mirrors the backend's registration validation exactly so server-returned
 * field errors surface in the same place as client-side errors.
 *
 * Field set is exactly the PRD-named fields — no more (POPIA data minimisation).
 * consentGiven is a client-side gate only; the backend stamps consentVersion
 * server-side from a placeholder constant.
 */
import { z } from 'zod';

export const rsvpSchema = z.object({
  firstName: z.string().min(1, 'Required').max(100),
  surname: z.string().min(1, 'Required').max(100),
  age: z.coerce
    .number({ invalid_type_error: 'Must be a number' })
    .int('Must be a whole number')
    .min(0, 'Must be 0 or older')
    .max(120, 'Must be 120 or under'),
  email: z.string().email('Valid email required'),
  phone: z.string().min(1, 'Required'),
  honeypot: z.string().optional(),
  consentGiven: z.literal(true, {
    errorMap: () => ({ message: 'You must agree to the privacy notice to register' }),
  }),
});

export type RsvpFormValues = z.infer<typeof rsvpSchema>;
