/**
 * Password hashing (plan.md Phase 3 step 2 — "Password hashing").
 *
 * Thin wrapper around `argon2` (already pinned at `0.41.1`) that pins EXPLICIT
 * argon2id parameters rather than relying on the library's defaults. Library
 * defaults can — and have — changed between versions (argon2 bumped its default
 * `memoryCost` upward in past major releases); pinning here means a `npm`
 * upgrade can never silently change how expensive (or cheap) every password
 * hash on this system is, and gives future reviewers one documented, reviewed
 * place to see exactly what was chosen and why.
 *
 * Lives in `modules/auth/` rather than `lib/` — this is auth-domain-specific
 * (the parameters are chosen with THIS deployment's login-endpoint threat model
 * in mind, not a generic "hash some bytes" utility), and `AuthService` is its
 * only intended caller (user creation, password reset, login verification).
 *
 * ---------------------------------------------------------------------------
 * Chosen parameters — and why
 * ---------------------------------------------------------------------------
 *   type:        argon2id   (hybrid mode — resists both GPU cracking and
 *                            side-channel/timing attacks; the OWASP Password
 *                            Storage Cheat Sheet's recommended variant for new
 *                            systems, and what architecture.md §9.1 specifies)
 *   memoryCost:  12288 KiB  (12 MiB)
 *   timeCost:    3 iterations
 *   parallelism: 1 thread
 *
 * Source/reasoning: the OWASP Password Storage Cheat Sheet (2024/2025 guidance)
 * gives two pinned argon2id configurations depending on constraints:
 *   - `m=19456 (19 MiB), t=2, p=1`           — the general "current minimum"
 *   - `m=12288 (12 MiB), t=3, p=1`           — explicitly offered as the choice
 *                                              "if much less memory is available"
 *
 * architecture.md §11 deploys to "a single Linode VPS" — Linode's smallest
 * production-viable plans sit in the 1–4 GB RAM range, shared with Postgres,
 * Nginx, PM2, and the Node process itself (no dedicated auth-hashing hardware).
 * The brief explicitly warns that an over-large `memoryCost` is ITSELF a DoS
 * vector here: argon2 is memory-HARD by design, so N concurrent login attempts
 * (legitimate traffic spike, or a deliberate brute-force burst against the
 * rate-limited login endpoint — see `AuthService`) each provision `memoryCost`
 * KiB simultaneously. At `m=19456`, just ~50 concurrent hashes would demand
 * ~950 MiB — enough to push a small VPS into swap or OOM-kill territory under
 * exactly the kind of burst this parameter is meant to defend against, turning
 * the defense into the attack. `m=12288` (12 MiB) keeps that same-burst
 * footprint at ~600 MiB for 50 concurrent attempts — still substantial, but
 * meaningfully safer headroom on a box this size — while the higher `timeCost`
 * (3 vs. 2) keeps the per-hash *computational* cost (and therefore brute-force
 * resistance) comparable to the 19 MiB/2-iteration profile, which is exactly
 * the trade-off OWASP documents this second profile for.
 *
 * `parallelism: 1` matches both OWASP profiles and avoids argon2 spinning up
 * multiple lanes per hash — on a small VPS sharing cores with Postgres/Nginx/PM2,
 * single-threaded hashing keeps the CPU-contention profile predictable under
 * concurrent login bursts (the same reasoning as the memory-cost choice above,
 * applied to CPU rather than RAM).
 *
 * If the VPS is ever upsized (architecture.md doesn't pin a specific plan),
 * revisit these constants — `npx prisma ...`-style "just bump it" upgrades are
 * NOT appropriate for password hashes: changing parameters does not invalidate
 * existing hashes (argon2's encoded PHC string carries its own parameters, and
 * `argon2.verify` reads them from the hash rather than from these constants),
 * so a future increase can be rolled out gradually as users next authenticate
 * — no migration/rehash-everything step required.
 */
import * as argon2 from 'argon2';

/** Pinned argon2id parameters — see file-header for sourcing/reasoning. Exported
 * (read-only) so tests can assert the encoded hash actually carries them. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 12_288, // KiB (12 MiB)
  timeCost: 3, // iterations
  parallelism: 1, // thread
} as const;

/**
 * Hashes a plaintext password into an argon2id PHC-format string
 * (`$argon2id$v=19$m=12288,t=3,p=1$<salt>$<hash>`) suitable for storage in
 * `User.passwordHash`. argon2 generates a fresh per-call random salt — callers
 * never need to (and must not) manage salts themselves.
 *
 * Used on user creation and password reset (plan.md Phase 3 step 2 / `AuthService`).
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against a previously-stored argon2id hash.
 * Returns `false` (never throws) for a non-matching password; only rejects on
 * a genuinely malformed/unrecognized hash string (e.g. corrupted data), which
 * `argon2.verify` itself throws on — callers (e.g. `AuthService.login`) should
 * treat that the same as "verification failed" rather than letting it bubble as
 * a 500, since a malformed stored hash is an internal-data problem, not
 * something the caller can act on differently.
 *
 * Note: `argon2.verify` reads the hash's own embedded parameters (not
 * `ARGON2_OPTIONS`) to perform the comparison — this is what makes a future
 * parameter change forward-compatible with existing stored hashes (see
 * file-header note).
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}
