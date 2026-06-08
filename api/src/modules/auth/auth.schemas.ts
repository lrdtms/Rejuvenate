/**
 * Zod request-validation schemas for the auth module's routes (plan.md
 * Phase 3 step 4), consumed via `validate({ body: ... })` (see
 * `middleware/validate.ts` — and its file-header doc-comment for the
 * project-wide "schemas are duplicated per module, mirrored by hand in the
 * SPA" convention every module follows; read that before changing this file's
 * shape, since the SPA's `web/src/shared/schemas/auth.schema.ts` mirrors it).
 */
import { z } from 'zod';

/** `POST /api/v1/auth/login` body. */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  // Deliberately NOT validating password shape/strength here beyond "present
  // and non-empty" — this is a VERIFICATION endpoint, not account creation.
  // Rejecting "your password doesn't meet our complexity rules" at LOGIN time
  // would be both useless (the account already has whatever password it has)
  // and a minor enumeration signal of its own (different validation errors
  // for different inputs). Password strength belongs at account-creation/
  // reset time (`confirmPasswordResetSchema` below), where it actually
  // affects what gets stored.
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** `POST /api/v1/auth/password-reset/request` body. */
export const requestPasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

/**
 * Minimum acceptable length for a NEW password (set at reset-confirm time).
 * 12 characters — comfortably above the historical "8 characters" baseline
 * and aligned with current NIST/OWASP guidance that favours LENGTH over
 * forced complexity rules (no mandatory "must contain a symbol" theatre,
 * which mostly trains users toward predictable substitutions like `P@ssw0rd1`
 * rather than meaningfully raising entropy). argon2id (see `password.ts`)
 * is the actual defense against offline cracking; this floor exists only to
 * stop trivially-guessable choices like `password123` at the door.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** `POST /api/v1/auth/password-reset/confirm` body. */
export const confirmPasswordResetSchema = z.object({
  // The raw, high-entropy token emailed to the user (see `auth.service.ts`'s
  // `generateRawResetToken` — base64url-encoded, ~43 chars for 32 bytes).
  // Validated only as "a non-empty string" — its cryptographic shape is an
  // implementation detail of THIS service; tightening this regex to match
  // today's encoding would make a future token-format change a two-file
  // change instead of one, for no real validation benefit (an invalid-shaped
  // token simply won't match any stored `tokenHash` and is rejected with the
  // same generic error as any other invalid token).
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`),
});
export type ConfirmPasswordResetInput = z.infer<typeof confirmPasswordResetSchema>;
