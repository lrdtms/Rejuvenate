/**
 * Unit tests for the fixed CMS slot registry (plan.md Phase 4d step 1 — "the
 * single most important file for ADR-0007 compliance"). No DB access — pure,
 * synchronous assertions against the registry's exported shape and lookup
 * primitives, mirroring `slug.test.ts`'s "tiny, isolated, pure-function"
 * posture.
 *
 * ===========================================================================
 * Registry/seed PARITY — the test that catches the documented drift risk
 * ===========================================================================
 * `cms.slots.ts`'s file header names a real, accepted risk: this registry
 * and `prisma/seed.ts`'s `CMS_SLOTS` describe the same six rows but live as
 * two separate lists (a deliberate choice — see that header for the full
 * "why not have the seed import from here" reasoning). The mitigation named
 * there is THIS test: assert the two lists describe the identical set of
 * `slotKey`s with identical `format`s, so any future edit that updates one
 * list without the other fails LOUDLY in `npm test`, not silently in
 * production months later.
 *
 * Mechanically: read `prisma/seed.ts`'s SOURCE TEXT and regex-extract its
 * `CMS_SLOTS` entries — deliberately NOT a runtime `import` of that file
 * (which would itself recreate the exact cross-layer dependency edge — test
 * code reaching from `src/` into `prisma/`'s `tsx`-run, `@prisma/client`-enum
 * -typed world — the registry's own header explains the seed should NOT have
 * to reach back the other way; a test that imported it would be just as
 * layering-inverted, only in the opposite direction). A source-text
 * assertion is exactly the right weight for "these two human-maintained
 * lists must agree" — it reads the same artifact a reviewer would, and
 * fails with a clear diff-able message if the lists ever diverge.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CMS_SLOTS, findRegisteredSlot, isRegisteredSlot } from './cms.slots';

/** Path to `prisma/seed.ts`, resolved relative to this test file's location
 * (`src/modules/cms/`) — three levels up to `api/`, then into `prisma/`. */
const SEED_FILE_PATH = resolve(__dirname, '../../../prisma/seed.ts');

/**
 * Extracts `{ slotKey: '...', format: CMSFormat.XXX, ... }` entries from
 * `prisma/seed.ts`'s source text. Deliberately tolerant of the surrounding
 * object-literal shape (it doesn't care about the `value: ''` field this
 * registry doesn't carry — see `cms.slots.ts`'s "why no `value` field" note)
 * — it extracts exactly the two facts this parity test cares about:
 * `slotKey` and `format`.
 */
function extractSeedSlots(source: string): Array<{ slotKey: string; format: string }> {
  const entryPattern =
    /slotKey:\s*'([^']+)'\s*,\s*format:\s*CMSFormat\.([A-Z_]+)/g;
  const found: Array<{ slotKey: string; format: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(source)) !== null) {
    // The regex's two capture groups are both mandatory (non-optional)
    // patterns — a successful match guarantees both are defined strings;
    // the non-null assertions document that guarantee rather than
    // re-deriving a runtime check (mirrors `blog.router.ts`'s `req.user!`
    // "the gate already proved this" convention).
    found.push({ slotKey: match[1]!, format: match[2]! });
  }

  return found;
}

describe('CMS_SLOTS registry (plan.md Phase 4d step 1)', () => {
  it('contains exactly the six named slots from plan.md Phase 1 / architecture.md §7.2', () => {
    const keys = CMS_SLOTS.map((slot) => slot.slotKey);

    expect(keys).toEqual([
      'about.card.who-are-we',
      'about.card.what-we-do',
      'about.card.get-involved',
      'contact.capeTown.card',
      'contact.durban.card',
      'contact.page.details',
    ]);
  });

  it('every entry currently uses PLAIN_TEXT (the documented current state — RICH_TEXT is supported but unused today)', () => {
    for (const slot of CMS_SLOTS) {
      expect(slot.format).toBe('PLAIN_TEXT');
    }
  });

  it('contains no duplicate slotKeys (the registry is the uniqueness source of truth the @unique column mirrors)', () => {
    const keys = CMS_SLOTS.map((slot) => slot.slotKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('registry/seed parity — catches drift between cms.slots.ts and prisma/seed.ts', () => {
    it('prisma/seed.ts CMS_SLOTS describes the identical set of slotKeys with identical formats', () => {
      const seedSource = readFileSync(SEED_FILE_PATH, 'utf-8');
      const seedSlots = extractSeedSlots(seedSource);

      // Sanity check on the EXTRACTOR itself — if this fails, the regex
      // above has stopped matching `prisma/seed.ts`'s actual shape (e.g. the
      // seed file was reformatted) and the parity assertions below would be
      // VACUOUSLY true (comparing `[]` to `[]`-shaped derived data) without
      // this guard. A non-empty extraction proves the regex is actually
      // finding real entries, not silently matching nothing.
      expect(seedSlots.length).toBeGreaterThan(0);

      const registryByKey = new Map(CMS_SLOTS.map((slot) => [slot.slotKey, slot.format]));
      const seedByKey = new Map(seedSlots.map((slot) => [slot.slotKey, slot.format]));

      expect(
        seedByKey.size,
        'prisma/seed.ts CMS_SLOTS slotKey count must match the registry — see cms.slots.ts header for the parity contract',
      ).toBe(registryByKey.size);

      for (const [slotKey, registryFormat] of registryByKey) {
        const seedFormat = seedByKey.get(slotKey);
        expect(
          seedFormat,
          `prisma/seed.ts CMS_SLOTS is missing slotKey "${slotKey}" — registry and seed have drifted (see cms.slots.ts header)`,
        ).toBeDefined();
        expect(
          seedFormat,
          `prisma/seed.ts CMS_SLOTS["${slotKey}"].format ("${seedFormat}") disagrees with the registry's ("${registryFormat}") — registry and seed have drifted (see cms.slots.ts header)`,
        ).toBe(registryFormat);
      }

      for (const slotKey of seedByKey.keys()) {
        expect(
          registryByKey.has(slotKey),
          `prisma/seed.ts CMS_SLOTS contains slotKey "${slotKey}" that is NOT in the registry — registry and seed have drifted (see cms.slots.ts header)`,
        ).toBe(true);
      }
    });
  });
});

describe('findRegisteredSlot / isRegisteredSlot (plan.md Phase 4d step 1)', () => {
  it('findRegisteredSlot returns the matching entry for a registered slotKey', () => {
    const found = findRegisteredSlot('about.card.who-are-we');
    expect(found).toEqual({ slotKey: 'about.card.who-are-we', format: 'PLAIN_TEXT' });
  });

  it('findRegisteredSlot returns undefined for an unregistered slotKey', () => {
    expect(findRegisteredSlot('about.card.does-not-exist')).toBeUndefined();
    expect(findRegisteredSlot('')).toBeUndefined();
    expect(findRegisteredSlot('ABOUT.CARD.WHO-ARE-WE')).toBeUndefined(); // case-sensitive
  });

  it('isRegisteredSlot agrees with findRegisteredSlot for both registered and unregistered keys', () => {
    for (const slot of CMS_SLOTS) {
      expect(isRegisteredSlot(slot.slotKey)).toBe(true);
    }
    expect(isRegisteredSlot('not.a.real.slot')).toBe(false);
    expect(isRegisteredSlot('')).toBe(false);
  });
});
