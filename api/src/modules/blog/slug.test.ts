/**
 * Unit tests for the pure slug-derivation helpers (`slugify`/`slugCandidate`,
 * plan.md Phase 4a step 2). No DB access — see `slug.ts`'s file header for
 * why these are deliberately kept tiny, isolated, and trivially testable in
 * isolation from the collision-checking machinery (`BlogService
 * .generateUniqueSlug`, covered by `blog.service.test.ts`'s
 * "slug collision generation" suite against the real DB).
 */
import { describe, expect, it } from 'vitest';

import { slugCandidate, slugify } from './slug';

describe('slugify (plan.md Phase 4a step 2)', () => {
  it('lower-cases and replaces whitespace/punctuation runs with single hyphens', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  Spaces   Everywhere  ')).toBe('spaces-everywhere');
  });

  it('strips diacritics to plain ASCII (Unicode-normalizes before collapsing)', () => {
    expect(slugify('Café Société')).toBe('cafe-societe');
    expect(slugify('Naïve Über')).toBe('naive-uber');
  });

  it('trims leading/trailing hyphens left over from edge punctuation', () => {
    expect(slugify('-- Leading and Trailing --')).toBe('leading-and-trailing');
    expect(slugify('!!!Shouting!!!')).toBe('shouting');
  });

  it('collapses runs of mixed non-alphanumeric characters into a single hyphen', () => {
    expect(slugify('A & B + C')).toBe('a-b-c');
    expect(slugify('one...two---three')).toBe('one-two-three');
  });

  it('preserves digits', () => {
    expect(slugify('Top 10 Reasons to Visit in 2026')).toBe('top-10-reasons-to-visit-in-2026');
  });

  it('returns an empty string for input that is entirely punctuation/symbols (the documented edge case BlogService.baseSlugFor handles)', () => {
    expect(slugify('★★★')).toBe('');
    expect(slugify('... ??? !!!')).toBe('');
  });

  it('does not truncate long titles (no length cap — by design, see file header)', () => {
    const longTitle = 'A '.repeat(100) + 'Title';
    const result = slugify(longTitle);
    expect(result.startsWith('a-a-a')).toBe(true);
    expect(result.endsWith('title')).toBe(true);
  });
});

describe('slugCandidate (plan.md Phase 4a step 2 — collision policy)', () => {
  it('returns the bare base slug for attempt 1', () => {
    expect(slugCandidate(1, 'my-post')).toBe('my-post');
  });

  it('appends -2, -3, ... for subsequent attempts, matching the documented "append -2, -3" policy', () => {
    expect(slugCandidate(2, 'my-post')).toBe('my-post-2');
    expect(slugCandidate(3, 'my-post')).toBe('my-post-3');
    expect(slugCandidate(10, 'my-post')).toBe('my-post-10');
  });

  it('treats attempt 0 (or any value <= 1) the same as attempt 1 (defensive — never produces a bare "-N" suffix with no base)', () => {
    expect(slugCandidate(0, 'my-post')).toBe('my-post');
    expect(slugCandidate(-1, 'my-post')).toBe('my-post');
  });
});
