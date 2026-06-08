/**
 * Integration tests for `BlogService` (plan.md Phase 4a step 2).
 *
 * Exercised against the REAL local Postgres via the REAL `BlogRepository`
 * (constructed with the shared `db`) — mirroring `auth.service.test.ts`'s
 * established "no DB-mocking infrastructure exists; standing one up purely
 * for these assertions would be more machinery than it's worth" posture
 * (see that file's header, and `blog.repository.ts`'s own factory-doc note
 * pointing at the same convention). Each test creates its own throwaway
 * `User`/`BlogPost` fixtures with unique, randomly-suffixed values and
 * cleans them up in `afterEach`.
 *
 * Password hashing is NOT exercised here (these tests never log in — they
 * construct `AuthenticatedUser`-shaped plain objects directly, exactly as
 * `requireRole`'s resolved `req.user` would look) — so, unlike
 * `auth.service.test.ts`/`auth.router.test.ts`, no generous argon2id-driven
 * timeout is required.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { AuthenticatedUser } from '../auth/auth.service';
import { createBlogRepository } from './blog.repository';
import { createBlogService, type BlogService } from './blog.service';

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueTitle(label: string): string {
  return `Test Post ${label} ${uniqueSuffix()}`;
}

const repository = createBlogRepository({ db });
const service: BlogService = createBlogService({ repository });

let createdUserIds: string[] = [];
let createdPostIds: string[] = [];

afterEach(async () => {
  if (createdPostIds.length > 0) {
    await db.blogPost.deleteMany({ where: { id: { in: createdPostIds } } });
    createdPostIds = [];
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

/** Bare-minimum throwaway `User` row — `passwordHash` content is irrelevant
 * to these tests (nothing here ever authenticates), so a fixed placeholder
 * string is used rather than paying argon2id's real, deliberately-slow cost
 * (see file header — that expense belongs to the auth-module suites that are
 * actually testing hashing). */
async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
}): Promise<AuthenticatedUser> {
  const { label, role = 'BLOGGER' } = opts;
  const created = await db.user.create({
    data: {
      name: `Blog Test User (${label})`,
      email: `blog-service-test-${label}-${uniqueSuffix()}@example.invalid`,
      passwordHash: 'not-a-real-hash',
      role,
      isActive: true,
    },
  });
  createdUserIds.push(created.id);
  return { id: created.id, name: created.name, email: created.email, role: created.role, isActive: true };
}

async function createDraftPost(author: AuthenticatedUser, opts?: { title?: string; body?: string }) {
  const post = await service.createPost(author, {
    title: opts?.title ?? uniqueTitle('draft'),
    body: opts?.body ?? '<p>Some perfectly ordinary draft body content.</p>',
  });
  createdPostIds.push(post.id);
  return post;
}

describe('BlogService (plan.md Phase 4a step 2)', () => {
  describe('createPost — slug generation policy (creation-time, not "first publish")', () => {
    it('generates and persists a non-null, unique slug at creation time, before any publish action', async () => {
      const author = await createTestUser({ label: 'create-slug' });
      const title = uniqueTitle('Hello World');

      const post = await service.createPost(author, {
        title,
        body: '<p>Body content long enough to pass the minimum length bound.</p>',
      });
      createdPostIds.push(post.id);

      // Persisted immediately — `BlogPost.slug` is non-nullable + @unique
      // (see blog.service.ts's file-header slug-policy doc-comment for why
      // this is the schema-mandated freeze point).
      expect(post.slug).toBeTruthy();
      expect(post.slug.length).toBeGreaterThan(0);
      expect(post.status).toBe('DRAFT');
      expect(post.publishedAt).toBeNull();

      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded?.slug).toBe(post.slug);
    });

    it('keeps the slug stable across publish/unpublish/title-update — never regenerates it', async () => {
      const author = await createTestUser({ label: 'slug-stability' });
      const post = await createDraftPost(author);
      const originalSlug = post.slug;

      const published = await service.publish(author, post.id);
      expect(published.slug).toBe(originalSlug);
      expect(published.status).toBe('PUBLISHED');
      expect(published.publishedAt).not.toBeNull();

      const unpublished = await service.unpublish(author, post.id);
      expect(unpublished.slug).toBe(originalSlug);
      expect(unpublished.status).toBe('DRAFT');
      // `publishedAt` is preserved (re-publish history), not cleared.
      expect(unpublished.publishedAt).not.toBeNull();

      const updated = await service.updatePost(author, post.id, { title: 'A Brand New Title Entirely' });
      expect(updated.slug).toBe(originalSlug);
      expect(updated.title).toBe('A Brand New Title Entirely');
    });
  });

  describe('createPost — slug collision generation', () => {
    it('appends -2, -3, ... for titles that slugify to the same base', async () => {
      const author = await createTestUser({ label: 'slug-collision' });
      const sharedLabel = `Collision Title ${uniqueSuffix()}`;

      const first = await createDraftPost(author, { title: sharedLabel });
      const second = await createDraftPost(author, { title: sharedLabel });
      const third = await createDraftPost(author, { title: sharedLabel });

      expect(second.slug).toBe(`${first.slug}-2`);
      expect(third.slug).toBe(`${first.slug}-3`);

      // All three slugs are distinct and each is independently unique in the DB
      // (the @unique constraint would have thrown at INSERT time if not).
      const slugs = [first.slug, second.slug, third.slug];
      expect(new Set(slugs).size).toBe(3);
    });

    it('falls back to a stable placeholder base for a title that slugifies to an empty string', async () => {
      const author = await createTestUser({ label: 'slug-empty-base' });

      // "★★★" strips to nothing once diacritics/non-alphanumerics collapse —
      // see blog.service.ts's `baseSlugFor` doc-comment.
      const post = await service.createPost(author, {
        title: '★★★ ☆☆☆ ???',
        body: '<p>A perfectly fine body for an oddly-titled post.</p>',
      });
      createdPostIds.push(post.id);

      expect(post.slug).toBe('post');
    });
  });

  describe('createPost — sanitization on save', () => {
    it('strips disallowed tags/attributes from the body before persisting', async () => {
      const author = await createTestUser({ label: 'create-sanitize' });

      const dirtyBody =
        '<p>Hello <script>alert("xss")</script><strong onclick="evil()">world</strong></p>' +
        '<img src="javascript:alert(1)" onerror="evil()" alt="test">';

      const post = await service.createPost(author, {
        title: uniqueTitle('Sanitize On Create'),
        body: dirtyBody,
      });
      createdPostIds.push(post.id);

      expect(post.body).not.toContain('<script');
      expect(post.body).not.toContain('onclick');
      expect(post.body).not.toContain('onerror');
      expect(post.body).not.toContain('javascript:');
      // Allowed structure survives.
      expect(post.body).toContain('<strong>world</strong>');
      expect(post.body).toContain('Hello');
    });
  });

  describe('updatePost — sanitization on save', () => {
    it('sanitizes a newly-supplied body on update before persisting it', async () => {
      const author = await createTestUser({ label: 'update-sanitize' });
      const post = await createDraftPost(author);

      const dirtyBody = '<p onclick="evil()">Updated <script>alert(1)</script>content here.</p>';
      const updated = await service.updatePost(author, post.id, { body: dirtyBody });

      expect(updated.body).not.toContain('<script');
      expect(updated.body).not.toContain('onclick');
      expect(updated.body).toContain('Updated');
      expect(updated.body).toContain('content here.');
    });

    it('leaves the body untouched when only title is supplied (never coerces undefined into a sanitized string)', async () => {
      const author = await createTestUser({ label: 'update-title-only' });
      const post = await createDraftPost(author, { body: '<p>Original body content stays exactly as-is.</p>' });

      const updated = await service.updatePost(author, post.id, { title: 'Only The Title Changes' });

      expect(updated.title).toBe('Only The Title Changes');
      expect(updated.body).toBe(post.body);
    });
  });

  describe('ownership enforcement — Blogger cannot mutate another author\'s post by id', () => {
    it('rejects updatePost on another author\'s post with 403 FORBIDDEN', async () => {
      const owner = await createTestUser({ label: 'owner-update' });
      const intruder = await createTestUser({ label: 'intruder-update' });
      const post = await createDraftPost(owner);

      await expect(service.updatePost(intruder, post.id, { title: 'Hostile Takeover Attempt' })).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });

      // Verify nothing changed.
      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded?.title).toBe(post.title);
    });

    it('rejects deletePost on another author\'s post with 403 FORBIDDEN, and does not delete it', async () => {
      const owner = await createTestUser({ label: 'owner-delete' });
      const intruder = await createTestUser({ label: 'intruder-delete' });
      const post = await createDraftPost(owner);

      await expect(service.deletePost(intruder, post.id)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });

      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded).not.toBeNull();
    });

    it('rejects publish on another author\'s post with 403 FORBIDDEN, and leaves it DRAFT', async () => {
      const owner = await createTestUser({ label: 'owner-publish' });
      const intruder = await createTestUser({ label: 'intruder-publish' });
      const post = await createDraftPost(owner);

      await expect(service.publish(intruder, post.id)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });

      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded?.status).toBe('DRAFT');
      expect(reloaded?.publishedAt).toBeNull();
    });

    it('rejects unpublish on another author\'s published post with 403 FORBIDDEN, and leaves it PUBLISHED', async () => {
      const owner = await createTestUser({ label: 'owner-unpublish' });
      const intruder = await createTestUser({ label: 'intruder-unpublish' });
      const post = await createDraftPost(owner);
      await service.publish(owner, post.id);

      await expect(service.unpublish(intruder, post.id)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });

      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded?.status).toBe('PUBLISHED');
    });

    it('allows an Admin to act on any author\'s post (update/publish/unpublish/delete)', async () => {
      const author = await createTestUser({ label: 'author-for-admin' });
      const admin = await createTestUser({ label: 'admin-override', role: 'ADMIN' });
      const post = await createDraftPost(author);

      const updated = await service.updatePost(admin, post.id, { title: 'Admin Edited This' });
      expect(updated.title).toBe('Admin Edited This');

      const published = await service.publish(admin, post.id);
      expect(published.status).toBe('PUBLISHED');

      const unpublished = await service.unpublish(admin, post.id);
      expect(unpublished.status).toBe('DRAFT');

      await service.deletePost(admin, post.id);
      // Already-deleted by the admin path — drop it from cleanup so afterEach
      // doesn't try (and fail) to delete it again.
      createdPostIds = createdPostIds.filter((id) => id !== post.id);

      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded).toBeNull();
    });

    it('throws 404 NOT_FOUND (not 403) for a nonexistent post id, regardless of actor role', async () => {
      const blogger = await createTestUser({ label: 'notfound-blogger' });
      const admin = await createTestUser({ label: 'notfound-admin', role: 'ADMIN' });
      const missingId = randomUUID();

      await expect(service.updatePost(blogger, missingId, { title: 'Does Not Matter' })).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      await expect(service.updatePost(admin, missingId, { title: 'Does Not Matter' })).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('listForUser — ownership-scoped listing', () => {
    it('scopes a Blogger to only their own posts', async () => {
      const blogger = await createTestUser({ label: 'list-blogger' });
      const otherAuthor = await createTestUser({ label: 'list-other-author' });

      const own = await createDraftPost(blogger);
      const others = await createDraftPost(otherAuthor);

      const result = await service.listForUser(blogger, { page: 1, limit: 50 });
      const ids = result.items.map((p) => p.id);

      expect(ids).toContain(own.id);
      expect(ids).not.toContain(others.id);
    });

    it('lets an Admin see every author\'s posts', async () => {
      const admin = await createTestUser({ label: 'list-admin', role: 'ADMIN' });
      const authorA = await createTestUser({ label: 'list-author-a' });
      const authorB = await createTestUser({ label: 'list-author-b' });

      const postA = await createDraftPost(authorA);
      const postB = await createDraftPost(authorB);

      const result = await service.listForUser(admin, { page: 1, limit: 100 });
      const ids = result.items.map((p) => p.id);

      expect(ids).toContain(postA.id);
      expect(ids).toContain(postB.id);
    });
  });

  describe('setSlug — Admin-only manual slug edit', () => {
    it('allows an Admin to set a fresh, valid, non-colliding slug', async () => {
      const admin = await createTestUser({ label: 'setslug-admin', role: 'ADMIN' });
      const author = await createTestUser({ label: 'setslug-author' });
      const post = await createDraftPost(author);

      const newSlug = `manually-renamed-${uniqueSuffix()}`;
      const updated = await service.setSlug(admin, post.id, newSlug);

      expect(updated.slug).toBe(newSlug);

      const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
      expect(reloaded?.slug).toBe(newSlug);
    });

    it('rejects setting a slug that collides with another post\'s slug — 409 CONFLICT', async () => {
      const admin = await createTestUser({ label: 'setslug-collision-admin', role: 'ADMIN' });
      const author = await createTestUser({ label: 'setslug-collision-author' });
      const postA = await createDraftPost(author);
      const postB = await createDraftPost(author);

      await expect(service.setSlug(admin, postB.id, postA.slug)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      const reloaded = await db.blogPost.findUnique({ where: { id: postB.id } });
      expect(reloaded?.slug).toBe(postB.slug);
    });

    it('throws 404 NOT_FOUND for a nonexistent post id', async () => {
      const admin = await createTestUser({ label: 'setslug-notfound-admin', role: 'ADMIN' });

      await expect(service.setSlug(admin, randomUUID(), `whatever-${uniqueSuffix()}`)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('public read paths — visibility invariants', () => {
    it(
      'getPublishedBySlug 404s for a PUBLISHED post whose publishedAt is in the future ' +
        '(scheduled-but-not-yet-live — must not be visible via direct slug access)',
      async () => {
        const author = await createTestUser({ label: 'scheduled-author' });
        const post = await createDraftPost(author);

        // Simulate a "scheduled publish" by directly stamping a future
        // publishedAt with status PUBLISHED — the exact shape architecture.md
        // §7.3 invariant #3 / plan.md Phase 4a step 3 warns must still 404 on
        // direct slug access despite `status === 'PUBLISHED'`.
        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.blogPost.update({ where: { id: post.id }, data: { status: 'PUBLISHED', publishedAt: future } });

        await expect(service.getPublishedBySlug(post.slug)).rejects.toMatchObject({
          statusCode: 404,
          code: 'NOT_FOUND',
        });
      },
    );

    it('getPublishedBySlug 404s identically for a genuinely nonexistent slug (collapsed outcome — no enumeration leak)', async () => {
      await expect(service.getPublishedBySlug(`no-such-slug-${uniqueSuffix()}`)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('getPublishedBySlug 404s for a DRAFT post (never published)', async () => {
      const author = await createTestUser({ label: 'draft-not-public' });
      const post = await createDraftPost(author);

      await expect(service.getPublishedBySlug(post.slug)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('getPublishedBySlug succeeds for a genuinely PUBLISHED, already-live post', async () => {
      const author = await createTestUser({ label: 'live-post-author' });
      const post = await createDraftPost(author);
      await service.publish(author, post.id);

      const found = await service.getPublishedBySlug(post.slug);
      expect(found.id).toBe(post.id);
      expect(found.author).toMatchObject({ id: author.id });
    });

    it('getPublished only returns live, published posts (excludes drafts and scheduled-future posts)', async () => {
      const author = await createTestUser({ label: 'mixed-visibility-author' });

      const draft = await createDraftPost(author);
      const live = await createDraftPost(author);
      await service.publish(author, live.id);

      const scheduled = await createDraftPost(author);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.blogPost.update({ where: { id: scheduled.id }, data: { status: 'PUBLISHED', publishedAt: future } });

      const result = await service.getPublished({ page: 1, limit: 100 });
      const ids = result.items.map((p) => p.id);

      expect(ids).toContain(live.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(scheduled.id);
    });
  });

  describe('AppError shape sanity', () => {
    it('throws real AppError instances (not generic Errors) for the documented failure modes', async () => {
      const blogger = await createTestUser({ label: 'apperror-shape' });

      try {
        await service.getPublishedBySlug(`definitely-not-a-slug-${uniqueSuffix()}`);
        expect.unreachable('expected getPublishedBySlug to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
      }

      try {
        await service.updatePost(blogger, randomUUID(), { title: 'x' });
        expect.unreachable('expected updatePost to throw for a missing post');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
      }
    });
  });
});
