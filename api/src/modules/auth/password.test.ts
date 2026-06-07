/**
 * Unit tests for the argon2id password-hashing wrapper (plan.md Phase 3 step 2).
 *
 * Deliberately uses the REAL pinned `ARGON2_OPTIONS` (not a "fast for tests"
 * config — the brief is explicit that doing so "would defeat the point of
 * testing the real values"). Argon2id is slow by design, so we keep the number
 * of hash/verify round-trips small (a handful, not dozens) — each call costs
 * real wall-clock time (`memoryCost`/`timeCost` are tuned for production
 * security, not test speed) and `vitest`'s default per-test timeout needs to
 * comfortably accommodate every hash this file performs.
 */
import { describe, expect, it } from 'vitest';

import { ARGON2_OPTIONS, hashPassword, verifyPassword } from './password';

// argon2id hashing at the pinned parameters takes real wall-clock time
// (memory-hard by design) — give these a generous bound well above the
// default 5s so CI/slower machines don't flake on a legitimately-slow-but-
// correct hash.
const HASH_TEST_TIMEOUT_MS = 20_000;

describe('password hashing (argon2id)', () => {
  it(
    'round-trips: a hashed password verifies successfully against its original plaintext',
    async () => {
      const plaintext = 'correct horse battery staple 42';

      const hash = await hashPassword(plaintext);
      const result = await verifyPassword(hash, plaintext);

      expect(result).toBe(true);
    },
    HASH_TEST_TIMEOUT_MS,
  );

  it(
    'rejects verification against the wrong plaintext',
    async () => {
      const hash = await hashPassword('the-real-password-123');

      const result = await verifyPassword(hash, 'a-completely-different-guess');

      expect(result).toBe(false);
    },
    HASH_TEST_TIMEOUT_MS,
  );

  it(
    'produces a PHC-format hash string with the $argon2id$ variant prefix',
    async () => {
      const hash = await hashPassword('another-test-password-456');

      expect(hash.startsWith('$argon2id$')).toBe(true);
    },
    HASH_TEST_TIMEOUT_MS,
  );

  it(
    'encodes the pinned memoryCost/timeCost/parallelism parameters in the hash string',
    async () => {
      // PHC format: $argon2id$v=19$m=<memoryCost>,t=<timeCost>,p=<parallelism>$<salt>$<hash>
      // Decoding it ourselves (rather than trusting argon2.verify's internal
      // parameter handling) is the only way to assert "the constants we pinned
      // are actually the ones being applied" — a regression here (e.g. someone
      // changing ARGON2_OPTIONS without updating this test, or a library
      // upgrade silently overriding a value) would otherwise be invisible.
      const hash = await hashPassword('parameter-check-password-789');

      const match = hash.match(/\$m=(\d+),t=(\d+),p=(\d+)\$/);
      expect(match).not.toBeNull();

      const [, m, t, p] = match as RegExpMatchArray;
      expect(Number(m)).toBe(ARGON2_OPTIONS.memoryCost);
      expect(Number(t)).toBe(ARGON2_OPTIONS.timeCost);
      expect(Number(p)).toBe(ARGON2_OPTIONS.parallelism);
    },
    HASH_TEST_TIMEOUT_MS,
  );

  it(
    'verifyPassword returns false (never throws) for a malformed/garbage hash string',
    async () => {
      const result = await verifyPassword('not-a-real-argon2-hash', 'whatever');

      expect(result).toBe(false);
    },
    HASH_TEST_TIMEOUT_MS,
  );
});
