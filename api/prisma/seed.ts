/**
 * Idempotent Prisma seed script (Phase 1, plan.md step 4).
 *
 * Run via `npm run prisma:seed` (wired to `tsx prisma/seed.ts`). Safe to run
 * any number of times against the same database — every write below is an
 * `upsert` keyed on a unique column, never a bare `create`.
 *
 * What this seeds:
 *   1. One bootstrap ADMIN user — solves the chicken-and-egg "how do I log in
 *      to create the first admin?" problem. The password is generated at
 *      seed-time, hashed with argon2id before storage, and printed to the
 *      console EXACTLY ONCE (only on the run that actually creates the row).
 *   2. The fixed CMS slot registry (architecture.md §7.2 / ADR-0007) — the six
 *      named slots the frontend renders. The CMS module must reject writes to
 *      any slotKey outside this registry (architecture.md §7.3 invariant #8);
 *      this script is the registry's source of truth at the data level.
 *
 * SECURITY NOTES:
 *   - Never commit a real password or password hash to the repo. The bootstrap
 *     password is either read from the gitignored `.env` (SEED_ADMIN_PASSWORD)
 *     or generated randomly at runtime with Node's `crypto` — it is NEVER
 *     hard-coded here.
 *   - There is currently NO "must change password on first login" mechanism on
 *     `User` (no such field in schema.prisma — adding one would be Phase 3/auth
 *     scope-creep requiring a migration). Until Phase 3 builds that flow, the
 *     console banner below is the only safeguard — read it, change the
 *     password immediately after first login.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient, CMSFormat } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Bootstrap admin
// ---------------------------------------------------------------------------

// Fixed, predictable seed identity for the bootstrap admin account. Override
// via env if an operator needs a different address for a given environment
// (e.g. production bootstrap with a real staff email). Not documented in
// .env.example as *required* — both have sensible defaults — but operators
// may set them for a one-off production bootstrap run.
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim() || 'admin@rejuvenate.org.za';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME?.trim() || 'Rejuvenate Admin';

/**
 * Generates a random, URL-safe bootstrap password using Node's built-in
 * `crypto` module — no extra dependency required. 24 random bytes -> 32
 * base64url characters, comfortably high entropy for a one-time bootstrap
 * credential that the operator is expected to rotate immediately.
 */
function generateBootstrapPassword(): string {
  return randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------
// CMS slot registry (architecture.md §7.2 — fixed named slots, ADR-0007)
// ---------------------------------------------------------------------------

// Exactly the six slot keys named in plan.md Phase 1 step 4 / fitness-function
// item #3. Do not add, remove, or rename slots here without updating the CMS
// module's allow-list and the architecture doc in lockstep — the API must
// reject writes to any slotKey outside this registry.
const CMS_SLOTS: ReadonlyArray<{ slotKey: string; format: CMSFormat; value: string }> = [
  { slotKey: 'about.card.who-are-we', format: CMSFormat.PLAIN_TEXT, value: '' },
  { slotKey: 'about.card.what-we-do', format: CMSFormat.PLAIN_TEXT, value: '' },
  { slotKey: 'about.card.get-involved', format: CMSFormat.PLAIN_TEXT, value: '' },
  { slotKey: 'contact.capeTown.card', format: CMSFormat.PLAIN_TEXT, value: '' },
  { slotKey: 'contact.durban.card', format: CMSFormat.PLAIN_TEXT, value: '' },
  { slotKey: 'contact.page.details', format: CMSFormat.PLAIN_TEXT, value: '' },
];
// `value: ''` (empty string) rather than placeholder copy: this matches the
// "safe empty default" contract the frontend's getSlot helper is expected to
// rely on (plan.md Phase 4d) and is more honest about "not yet written" than
// a fake placeholder string that an editor might forget to replace.

async function seedAdminUser(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    // Row already exists — DO NOT regenerate or reset the password. Doing so
    // on every seed run would be surprising and could lock out an admin who
    // already changed their bootstrap password (the whole point of the
    // "change it immediately" instruction).
    await prisma.user.update({
      where: { email: ADMIN_EMAIL },
      data: {
        // Idempotent "make sure the bootstrap admin is in the expected shape"
        // touch-up — keeps name/role/active in sync without touching the
        // credential. Safe to repeat: identical values produce no real change.
        name: ADMIN_NAME,
        role: 'ADMIN',
        isActive: true,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] Admin user already exists (${ADMIN_EMAIL}) — left password untouched.`);
    return;
  }

  // First-ever run: generate (or read from env) a bootstrap password, hash it,
  // create the row, and print the plaintext ONCE. After this run, the `if`
  // branch above always wins, so this block — and the console banner — never
  // run again for this email.
  const plaintextPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || generateBootstrapPassword();
  // argon2.hash()'s default is the argon2id variant (per the task brief —
  // Phase 3's AuthService owns pinning specific cost parameters; the library
  // default is appropriate for this one-off bootstrap credential).
  const passwordHash = await argon2.hash(plaintextPassword);

  await prisma.user.create({
    data: {
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
    },
  });

  const banner = [
    '',
    '================================================================',
    '  BOOTSTRAP ADMIN ACCOUNT CREATED — ONE-TIME CREDENTIAL PRINTOUT',
    '================================================================',
    `  Email:    ${ADMIN_EMAIL}`,
    `  Password: ${plaintextPassword}`,
    '----------------------------------------------------------------',
    '  CHANGE THIS PASSWORD IMMEDIATELY AFTER YOUR FIRST LOGIN.',
    '  There is currently NO enforced "must change password on first',
    '  login" flow — that is planned for Phase 3 (auth module). This',
    '  printout is your only copy: it is hashed (argon2id) before',
    '  storage and will not be shown again by this script.',
    '================================================================',
    '',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(banner);
}

async function seedCmsSlots(): Promise<void> {
  for (const slot of CMS_SLOTS) {
    await prisma.cMSContent.upsert({
      where: { slotKey: slot.slotKey },
      update: {}, // Existing rows are left untouched — an editor's saved copy
      // must never be clobbered back to the placeholder by re-seeding.
      create: {
        slotKey: slot.slotKey,
        format: slot.format,
        value: slot.value,
        // Left null rather than attributed to the bootstrap admin: nothing
        // has actually been "edited" yet — this is registry scaffolding, not
        // an editorial act. `lastEditedById` should reflect a real edit by a
        // real operator the first time the slot's content is actually set.
        lastEditedById: null,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] CMS slot registry ensured (${CMS_SLOTS.length} slots): `);
  for (const slot of CMS_SLOTS) {
    // eslint-disable-next-line no-console
    console.log(`         - ${slot.slotKey}`);
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[seed] Starting (idempotent — safe to run repeatedly)...');
  await seedAdminUser();
  await seedCmsSlots();
  // eslint-disable-next-line no-console
  console.log('[seed] Done.');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
