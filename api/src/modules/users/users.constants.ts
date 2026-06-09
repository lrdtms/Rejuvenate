/**
 * Shared, named constants for the Users module — referenced by
 * `users.schemas.ts` (validation bounds) and `users.service.ts` (business
 * rules). Centralizes the magic numbers so a future change is a single edit.
 */

/**
 * Ceiling for `User.email` at the API boundary. The DB column is a plain
 * `String` (effectively unbounded at the Prisma/Postgres layer — same "the
 * schema can store anything; the API boundary is where a sane ceiling
 * belongs" reasoning as `MAX_SLOT_VALUE_LENGTH` / `MAX_TITLE_LENGTH`). 254
 * characters is the RFC 5321 maximum length for an email address — a
 * meaningful, standards-derived bound rather than an arbitrary magic number.
 */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Byte length of the temporary password generated on account creation
 * (`crypto.randomBytes(TEMP_PASSWORD_BYTES).toString('hex')`). 16 bytes ->
 * 32 hex characters: easy to copy-paste by an Admin, while providing 128
 * bits of entropy — well above any practical brute-force budget for a
 * credential that is (a) single-use / change-on-first-login by convention,
 * (b) only ever transmitted to the account holder out-of-band, and (c)
 * protected by the same rate-limiting that guards the login endpoint.
 */
export const TEMP_PASSWORD_BYTES = 16;
