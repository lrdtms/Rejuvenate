/**
 * Integration tests for `CmsService` (plan.md Phase 4d step 2).
 *
 * Exercised against the REAL local Postgres via the REAL `CmsRepository`
 * (constructed with the shared `db`) — mirroring `blog.service.test.ts`'s/
 * `registrations.service.test.ts`'s established "no DB-mocking
 * infrastructure exists; standing one up purely for these assertions would
 * be more machinery than it's worth" posture.
 *
 * ===========================================================================
 * A NOTE ON FIXTURES — this module's rows are SEEDED, not created-per-test
 * ===========================================================================
 * Unlike `BlogPost`/`Event`/`Registration` (where every test creates and
 * destroys its own throwaway rows), `CMSContent` has exactly six rows, keyed
 * by `slotKey`, that the seed script idempotently `upsert`s on every run —
 * there is no "create a fresh CMSContent row" operation in this domain at
 * all (the registry is FIXED — see `cms.slots.ts`). Tests therefore:
 *
 *   - Use REAL registered `slotKey`s from `CMS_SLOTS` (never invented ones)
 *     for "real slot" scenarios.
 *   - For the "registered-but-unpopulated" scenario specifically (which
 *     requires a registered `slotKey` with NO `CMSContent` row — a state the
 *     seeded dev DB does NOT naturally have, since the seed populates all
 *     six), each test that needs it captures the slot's pre-existing row
 *     (if any), DELETES it to simulate the "row doesn't exist yet" state,
 *     runs its assertions, then RESTORES the original row in `finally` —
 *     never leaving the shared seeded fixture in a different state than it
 *     found it (a hard requirement: other suites — and a developer's local
 *     manual testing against the same DB — depend on the seed's invariants
 *     holding). `withSlotRowRemoved` below is the single, named helper that
 *     performs this capture/delete/restore dance exactly once, correctly,
 *     so no individual test has to get the ordering right by hand.
 *   - `lastEditedById`-stamping/round-trip tests use `updateSlot` itself
 *     (which `upsert`s) — these naturally restore the prior `value` in
 *     `afterEach` by writing back whatever the row held before the test
 *     ran, for the same "leave the shared fixture as found" reason.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CMSContent } from '@prisma/client';

import { db } from '../../lib/db';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CMS_SLOTS } from './cms.slots';
import { createCmsRepository } from './cms.repository';
import { createCmsService, type CmsService } from './cms.service';

function uniqueSuffix(): string {
  return randomUUID();
}

const repository = createCmsRepository({ db });
const service: CmsService = createCmsService({ repository });

/** A real, registered `PLAIN_TEXT` slot — every entry in today's registry is
 * `PLAIN_TEXT` (see `cms.slots.test.ts`'s "every entry currently uses
 * PLAIN_TEXT" assertion), so any registry entry serves; naming one
 * explicitly here documents the assumption rather than leaving it implicit
 * in `CMS_SLOTS[0]`. */
const PLAIN_TEXT_SLOT_KEY = 'about.card.who-are-we';

/** A second real, registered slot — used by tests that need two distinct
 * slots in play (e.g. the batch-fetch "every requested key present"
 * assertions) without colliding with `PLAIN_TEXT_SLOT_KEY`'s row-removal
 * dance in the same test run. */
const SECOND_SLOT_KEY = 'about.card.what-we-do';

const UNREGISTERED_SLOT_KEY = `not.a.real.slot.${uniqueSuffix()}`;

/**
 * Ensures every registered slot has a `CMSContent` row before this suite's
 * "populated slot" assertions run — making the suite SELF-SUFFICIENT rather
 * than dependent on `npm run prisma:seed` having been run against whichever
 * database `npm test` points at (a real gap: unlike `BlogPost`/`Event`/
 * `Registration`, this module's fixtures are SEEDED rows, not per-test
 * creations — see file header — and `npm test` does not itself invoke the
 * seed script). `upsert`ed (not `create`d) so this is idempotent and never
 * clobbers a row that already holds real content — exactly
 * `CmsRepository.upsertValue`'s own race-safe primitive, reused here for
 * the identical "create if missing, leave alone if present" guarantee.
 *
 * This does NOT replace `prisma/seed.ts` as the deployment-time mechanism
 * (production environments still rely on the seed script per
 * architecture.md §11's deploy sequence) — it exists purely so this test
 * file's assertions about "a populated slot's real-row view" have a
 * guaranteed-present row to assert against, in ANY environment `npm test`
 * runs in, seeded or not.
 */
beforeAll(async () => {
  for (const slot of CMS_SLOTS) {
    await db.cMSContent.upsert({
      where: { slotKey: slot.slotKey },
      create: { slotKey: slot.slotKey, format: slot.format, value: '' },
      update: {},
    });
  }
});

let createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

async function createTestUser(opts: { label: string; role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER' }): Promise<AuthenticatedUser> {
  const { label, role = 'ADMIN' } = opts;
  const created = await db.user.create({
    data: {
      name: `CMS Service Test User (${label})`,
      email: `cms-service-test-${label}-${uniqueSuffix()}@example.invalid`,
      passwordHash: 'not-a-real-hash',
      role,
      isActive: true,
    },
  });
  createdUserIds.push(created.id);
  return { id: created.id, name: created.name, email: created.email, role: created.role, isActive: true };
}

/**
 * Captures `slotKey`'s current row (if any), deletes it (simulating the
 * "registered-but-unpopulated" state — a real `CMSContent` row genuinely
 * absent for a real, registered slot), runs `fn`, then restores the
 * original row's exact prior state in a `finally` — guaranteeing the shared
 * seeded fixture is left exactly as found regardless of whether `fn` throws.
 *
 * Restoration recreates the row via a raw `upsert` keyed on `slotKey` (the
 * same race-safe primitive `CmsRepository.upsertValue` itself uses) with
 * the captured `format`/`value`/`lastEditedById` — i.e. byte-for-byte the
 * row that was there before, not a re-derived approximation of it.
 */
async function withSlotRowRemoved<T>(slotKey: string, fn: () => Promise<T>): Promise<T> {
  const original = await db.cMSContent.findUnique({ where: { slotKey } });

  if (original) {
    await db.cMSContent.delete({ where: { slotKey } });
  }

  try {
    return await fn();
  } finally {
    if (original) {
      await db.cMSContent.upsert({
        where: { slotKey },
        create: {
          slotKey: original.slotKey,
          format: original.format,
          value: original.value,
          lastEditedById: original.lastEditedById,
        },
        update: {
          format: original.format,
          value: original.value,
          lastEditedById: original.lastEditedById,
        },
      });
    }
  }
}

/** Restores `slotKey`'s `value`/`lastEditedById` to a captured prior state —
 * the counterpart `afterEach` cleanup for tests that call `updateSlot`
 * directly (which legitimately mutates the seeded row in place; there is no
 * "delete the row this test created" cleanup possible for a fixed-registry
 * resource — see file header). */
async function restoreSlotValue(prior: CMSContent): Promise<void> {
  await db.cMSContent.update({
    where: { slotKey: prior.slotKey },
    data: { value: prior.value, lastEditedById: prior.lastEditedById, format: prior.format },
  });
}

describe('CmsService (plan.md Phase 4d step 2)', () => {
  // =========================================================================
  // getSlot — single-slot read contract
  // =========================================================================
  describe('getSlot', () => {
    it('returns the real row’s view for a populated, registered slot', async () => {
      const row = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });

      const view = await service.getSlot(PLAIN_TEXT_SLOT_KEY);

      expect(view).toEqual({
        slotKey: PLAIN_TEXT_SLOT_KEY,
        format: row.format,
        value: row.value,
        updatedAt: row.updatedAt,
      });
    });

    it('returns a safe empty-string default — never a 404/throw — for a registered-but-unpopulated slot', async () => {
      await withSlotRowRemoved(PLAIN_TEXT_SLOT_KEY, async () => {
        const view = await service.getSlot(PLAIN_TEXT_SLOT_KEY);

        expect(view).toEqual({
          slotKey: PLAIN_TEXT_SLOT_KEY,
          format: 'PLAIN_TEXT', // sourced from the REGISTRY, not guessed
          value: '',
          updatedAt: null, // honest "never written" signal — see file-header decision record
        });
      });
    });

    it('rejects a slotKey outside the registry with unknownSlot() (400 UNKNOWN_SLOT) — categorically different from "registered but empty"', async () => {
      await expect(service.getSlot(UNREGISTERED_SLOT_KEY)).rejects.toMatchObject({
        statusCode: 400,
        code: 'UNKNOWN_SLOT',
      });

      // The message names the offending key — see unknownSlot()'s doc-comment.
      await expect(service.getSlot(UNREGISTERED_SLOT_KEY)).rejects.toThrow(
        new RegExp(UNREGISTERED_SLOT_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    });
  });

  // =========================================================================
  // getSlots — batched read contract (the public /cms?keys=... shape)
  // =========================================================================
  describe('getSlots', () => {
    it('returns a MAP keyed by slotKey (not an array), with one entry per requested registered key', async () => {
      const map = await service.getSlots([PLAIN_TEXT_SLOT_KEY, SECOND_SLOT_KEY]);

      expect(Array.isArray(map)).toBe(false);
      expect(Object.keys(map).sort()).toEqual([PLAIN_TEXT_SLOT_KEY, SECOND_SLOT_KEY].sort());
      expect(map[PLAIN_TEXT_SLOT_KEY]?.slotKey).toBe(PLAIN_TEXT_SLOT_KEY);
      expect(map[SECOND_SLOT_KEY]?.slotKey).toBe(SECOND_SLOT_KEY);
    });

    it('includes a registered-but-unpopulated key with a safe empty value — never omitted', async () => {
      await withSlotRowRemoved(PLAIN_TEXT_SLOT_KEY, async () => {
        const map = await service.getSlots([PLAIN_TEXT_SLOT_KEY, SECOND_SLOT_KEY]);

        // Both requested keys are present...
        expect(Object.keys(map).sort()).toEqual([PLAIN_TEXT_SLOT_KEY, SECOND_SLOT_KEY].sort());

        // ...and the unpopulated one carries the documented safe-empty shape.
        expect(map[PLAIN_TEXT_SLOT_KEY]).toEqual({
          slotKey: PLAIN_TEXT_SLOT_KEY,
          format: 'PLAIN_TEXT',
          value: '',
          updatedAt: null,
        });

        // ...while the populated sibling is unaffected (a real row, real value).
        expect(map[SECOND_SLOT_KEY]?.updatedAt).not.toBeNull();
      });
    });

    it('omits an out-of-registry requested key from the response map (documented decision — see getSlots doc-comment)', async () => {
      const map = await service.getSlots([PLAIN_TEXT_SLOT_KEY, UNREGISTERED_SLOT_KEY]);

      expect(Object.keys(map)).toEqual([PLAIN_TEXT_SLOT_KEY]);
      expect(map[UNREGISTERED_SLOT_KEY]).toBeUndefined();
      expect(map[PLAIN_TEXT_SLOT_KEY]).toBeDefined();
    });

    it('does not throw for a batch consisting ENTIRELY of out-of-registry keys — returns an empty map', async () => {
      const map = await service.getSlots([UNREGISTERED_SLOT_KEY, `${UNREGISTERED_SLOT_KEY}-2`]);

      expect(map).toEqual({});
    });

    it('de-duplicates a key requested more than once into a single map entry', async () => {
      const map = await service.getSlots([PLAIN_TEXT_SLOT_KEY, PLAIN_TEXT_SLOT_KEY]);

      expect(Object.keys(map)).toEqual([PLAIN_TEXT_SLOT_KEY]);
    });
  });

  // =========================================================================
  // updateSlot — the single write path: registry check, format-aware
  // sanitization, lastEditedById stamping
  // =========================================================================
  describe('updateSlot', () => {
    it('rejects a write to a slotKey outside the registry with unknownSlot() — re-validated at the service layer, not merely trusted from the router', async () => {
      const editor = await createTestUser({ label: 'reject-unknown' });

      await expect(service.updateSlot(editor, UNREGISTERED_SLOT_KEY, 'New value')).rejects.toMatchObject({
        statusCode: 400,
        code: 'UNKNOWN_SLOT',
      });

      // Confirms the rejection happened BEFORE any write — no phantom row
      // was created for the unregistered key.
      const phantom = await db.cMSContent.findUnique({ where: { slotKey: UNREGISTERED_SLOT_KEY } });
      expect(phantom).toBeNull();
    });

    it('stamps lastEditedById from the authenticated editor on every write', async () => {
      const prior = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
      const editor = await createTestUser({ label: 'stamp-editor' });

      try {
        const updated = await service.updateSlot(editor, PLAIN_TEXT_SLOT_KEY, `Edited by ${editor.id} ${uniqueSuffix()}`);

        expect(updated.slotKey).toBe(PLAIN_TEXT_SLOT_KEY);

        const persisted = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
        expect(persisted.lastEditedById).toBe(editor.id);
      } finally {
        await restoreSlotValue(prior);
      }
    });

    it('round-trips: a written value is exactly what getSlot subsequently returns', async () => {
      const prior = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
      const editor = await createTestUser({ label: 'round-trip' });
      const newValue = `Round-trip value ${uniqueSuffix()} — "quoted" & <unescaped>`;

      try {
        const written = await service.updateSlot(editor, PLAIN_TEXT_SLOT_KEY, newValue);
        expect(written.value).toBe(newValue);

        const reread = await service.getSlot(PLAIN_TEXT_SLOT_KEY);
        expect(reread.value).toBe(newValue);
        expect(reread.updatedAt).toEqual(written.updatedAt);
      } finally {
        await restoreSlotValue(prior);
      }
    });

    describe('format-aware sanitization', () => {
      it('stores a PLAIN_TEXT value EXACTLY as received — does NOT run it through any HTML sanitizer', async () => {
        const prior = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
        expect(prior.format).toBe('PLAIN_TEXT'); // sanity: this slot really is plainText
        const editor = await createTestUser({ label: 'plain-text-untouched' });

        // Deliberately includes characters an HTML sanitizer WOULD mangle
        // (entities, angle brackets, ampersands, quotes) — the exact
        // "Tom & Jerry's Café" / "<3" class of legitimate literal content
        // `cms.service.ts`'s doc-comment names as what a wrongly-applied
        // rich-text sanitizer would corrupt.
        const literalValue = `Tom & Jerry's Café <3 — "quoted" <strong>not html</strong> <script>alert(1)</script>`;

        try {
          const written = await service.updateSlot(editor, PLAIN_TEXT_SLOT_KEY, literalValue);

          // Stored byte-for-byte — no entity-encoding, no tag-stripping.
          expect(written.value).toBe(literalValue);

          const persisted = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
          expect(persisted.value).toBe(literalValue);
        } finally {
          await restoreSlotValue(prior);
        }
      });

      it('sanitizes a RICH_TEXT value against CMS_RICH_TEXT_ALLOW_LIST — strips disallowed tags/attributes, keeps allowed ones', async () => {
        // No registered slot is RICH_TEXT today (see cms.slots.test.ts's
        // "every entry currently uses PLAIN_TEXT" assertion) — exercising
        // RICH_TEXT *sanitization* therefore cannot go through
        // `service.updateSlot` against a real registered slotKey (every one
        // would take the PLAIN_TEXT branch). Two approaches were considered:
        //
        //   (a) Inject a temporary RICH_TEXT entry into the registry for
        //       this test — REJECTED. `CMS_SLOTS` is a `readonly` const
        //       array (deliberately immutable — ADR-0007 compliance depends
        //       on it being a fixed, code-reviewed list, per `cms.slots.ts`'s
        //       file header); mutating/monkey-patching shared module-level
        //       state for one test risks polluting every OTHER test in this
        //       file that calls `findRegisteredSlot`/`isRegisteredSlot`.
        //   (b) Assert against `sanitizeCmsRichText` directly — CHOSEN. ✓
        //       `cms.service.ts`'s `updateSlot` doc-comment names this
        //       function as the ENTIRE unit of RICH_TEXT-branch behaviour:
        //       "passed through `sanitizeCmsRichText`... BEFORE
        //       persistence — the sanitizer IS the sanitization; the
        //       service performs no transformation of its own beyond
        //       SELECTING it by format." Asserting the shared sanitizer's
        //       behaviour here, against the EXACT allow-list
        //       `cms.service.ts` imports (`CMS_RICH_TEXT_ALLOW_LIST` via
        //       `sanitizeCmsRichText`) and applies verbatim, proves
        //       precisely "what `CmsService.updateSlot` would do to this
        //       input for a RICH_TEXT slot" — without requiring a registry
        //       seam this small, fixed, six-slot module has no other
        //       reason to grow. (The format-SELECTION half of the branch —
        //       "RICH_TEXT routes through the sanitizer, PLAIN_TEXT does
        //       not" — is covered end-to-end by the PLAIN_TEXT round-trip
        //       test above plus the registry's "every slot is PLAIN_TEXT
        //       today" assertion in `cms.slots.test.ts`; together the two
        //       tests cover both halves of the branch.)
        const { sanitizeCmsRichText } = await import('../../lib/sanitizeHtml');

        const dirty =
          '<p>Allowed paragraph with <strong>bold</strong> and <em>italic</em><br/>and a line break.</p>' +
          '<script>alert(1)</script>' + // disallowed tag — discarded entirely (incl. content)
          '<h2>Heading</h2>' + // disallowed tag for THIS allow-list (allowed for Blog, not CMS)
          '<a href="https://example.com" onclick="evil()">link</a>' + // disallowed tag + attr
          '<img src="x.png" onerror="evil()">' + // disallowed tag
          '<strong style="color:red" class="x" onclick="evil()">styled bold</strong>'; // disallowed attrs on an allowed tag

        const clean = sanitizeCmsRichText(dirty);

        // Allowed tags survive...
        expect(clean).toContain('<p>');
        expect(clean).toContain('<strong>bold</strong>');
        expect(clean).toContain('<em>italic</em>');
        expect(clean).toContain('<br');

        // ...disallowed tags (and, for <script>, their content) do not.
        expect(clean).not.toContain('<script');
        expect(clean).not.toContain('alert(1)');
        expect(clean).not.toContain('<h2');
        expect(clean).not.toContain('<a ');
        expect(clean).not.toContain('<img');

        // ...and disallowed attributes are stripped even from allowed tags —
        // the surviving "styled bold" text remains, but bare of any
        // style/class/on* attributes (CMS_RICH_TEXT_ALLOW_LIST's
        // `allowedAttributes: {}` — no attributes at all on any tag).
        expect(clean).toContain('styled bold');
        expect(clean).not.toContain('style=');
        expect(clean).not.toContain('class=');
        expect(clean).not.toContain('onclick');
        expect(clean).not.toContain('onerror');
      });
    });
  });
});

describe('CmsService — registry coverage sanity (plan.md Phase 4d)', () => {
  // Not a behavioural assertion about CmsService per se — a guard that the
  // fixture constants above (`PLAIN_TEXT_SLOT_KEY`/`SECOND_SLOT_KEY`) stay
  // valid, registered keys as the registry evolves; a future rename that
  // forgets to update these constants fails here, with a clear message,
  // rather than producing confusing `unknownSlot` failures scattered across
  // the suite above.
  beforeAll(() => {
    const keys = new Set(CMS_SLOTS.map((slot) => slot.slotKey));
    expect(keys.has(PLAIN_TEXT_SLOT_KEY)).toBe(true);
    expect(keys.has(SECOND_SLOT_KEY)).toBe(true);
    expect(PLAIN_TEXT_SLOT_KEY).not.toBe(SECOND_SLOT_KEY);
  });

  it('sanity check ran', () => {
    expect(true).toBe(true);
  });
});
