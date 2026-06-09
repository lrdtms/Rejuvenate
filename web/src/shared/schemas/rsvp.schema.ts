/**
 * rsvpSchema — Zod schema for the RSVP registration form.
 *
 * Mirrors the backend's registration validation exactly so server-returned
 * field errors surface in the same place as client-side errors.
 *
 * Field set is exactly the PRD-named fields — no more (POPIA data minimisation).
 * consentGiven is a client-side gate only; the backend stamps consentVersion
 * server-side from a placeholder constant.
 *
 * Uses Zod v4 API. age uses z.string().transform + refine so the input type
 * is string (matching what RHF reads from <input type="number">), satisfying
 * react-hook-form's FieldValues constraint while still producing a number on output.
 */
import { z } from 'zod';

export const rsvpSchema = z.object({
  firstName: z.string().min(1, 'Required').max(100),
  surname: z.string().min(1, 'Required').max(100),
  age: z
    .string()
    .min(1, 'Required')
    .transform((val, ctx) => {
      const num = Number(val);
      if (!Number.isFinite(num)) {
        ctx.addIssue({ code: 'custom', message: 'Must be a number' });
        return z.NEVER;
      }
      if (!Number.isInteger(num)) {
        ctx.addIssue({ code: 'custom', message: 'Must be a whole number' });
        return z.NEVER;
      }
      if (num < 0) {
        ctx.addIssue({ code: 'custom', message: 'Must be 0 or older' });
        return z.NEVER;
      }
      if (num > 120) {
        ctx.addIssue({ code: 'custom', message: 'Must be 120 or under' });
        return z.NEVER;
      }
      return num;
    }),
  email: z.string().email('Valid email required'),
  phone: z.string().min(1, 'Required'),
  honeypot: z.string().optional(),
  consentGiven: z.literal(true, {
    error: 'You must agree to the privacy notice to register',
  }),
});

export type RsvpFormValues = z.input<typeof rsvpSchema>;
export type RsvpFormOutput = z.output<typeof rsvpSchema>;
