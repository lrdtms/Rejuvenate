/**
 * Integration tests for the Blog module's router (plan.md Phase 4a steps 3-4),
 * exercised through the REAL `createApp()` — sessions, RBAC middleware,
 * validation, the central error handler, `BlogService`, and `BlogRepository`
 * (itself wired to the real local Postgres) all run for real, exactly as
 * `auth.router.test.ts` does for its concerns. This is the right layer to
 * verify "does `requireRole`/ownership/sanitization/visibility actually wire
 * together end-to-end through real HTTP requests and real session cookies" —
 * a question `blog.service.test.ts`'s direct-service-call tests cannot answer
 * (they bypass the router, the RBAC gate, and the HTTP/session machinery
 * entirely).
 *
 * Uses `request.agent(app)` (cookie jar across calls) for every flow that
 * needs an authenticated session — login once, then issue the real request
 * under test — mirroring `auth.router.test.ts`'s established pattern.
 *
 * Real argon2id hashing is in the loop for every login — generous per-test
 * timeouts mirror `auth.router.test.ts`'s `AUTH_TEST_TIMEOUT_MS`.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { db } from '../../lib/db';
import { hashPassword } from '../auth/password';

const BLOG_ROUTER_TEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = 'correct horse battery staple 42';

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueTitle(label: string): string {
  return `Router Test Post ${label} ${uniqueSuffix()}`;
}

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

async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
}) {
  const { label, role = 'BLOGGER' } = opts;
  const email = `blog-router-test-${label}-${uniqueSuffix()}@example.invalid`;
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const created = await db.user.create({
    data: { name: `Blog Router Test User (${label})`, email, passwordHash, role, isActive: true },
  });
  createdUserIds.push(created.id);
  return created;
}

/** Logs the given user in on a fresh `supertest.agent` and returns the agent
 * — every subsequent request through it carries the session cookie, exactly
 * like a real authenticated browser tab (mirrors `auth.router.test.ts`). */
async function loginAs(app: ReturnType<typeof createApp>, user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

/** Creates a post directly via Prisma (bypassing the service/router) for
 * setup convenience, with a real, valid, unique slug — tests that need a
 * pre-existing post (to PATCH/DELETE/publish/etc.) use this rather than
 * routing setup through the very HTTP surface under test. */
async function createPostFixture(opts: {
  authorId: string;
  title?: string;
  status?: 'DRAFT' | 'PUBLISHED';
  publishedAt?: Date | null;
  body?: string;
}) {
  const title = opts.title ?? uniqueTitle('fixture');
  const slug = `fixture-${uniqueSuffix()}`;
  const post = await db.blogPost.create({
    data: {
      title,
      slug,
      body: opts.body ?? '<p>Fixture body content with enough length to be valid.</p>',
      status: opts.status ?? 'DRAFT',
      publishedAt: opts.publishedAt ?? null,
      authorId: opts.authorId,
    },
  });
  createdPostIds.push(post.id);
  return post;
}

describe('Blog router (plan.md Phase 4a steps 3-4)', () => {
  // ===========================================================================
  // Public routes
  // ===========================================================================
  describe('GET /blog/posts — public, paginated, published-only', () => {
    it('returns only published, already-live posts (200, paginated envelope)', async () => {
      const app = createApp();
      const author = await createTestUser({ label: 'public-list-author' });

      const draft = await createPostFixture({ authorId: author.id, status: 'DRAFT' });
      const live = await createPostFixture({
        authorId: author.id,
        status: 'PUBLISHED',
        publishedAt: new Date(Date.now() - 60_000),
      });
      const scheduled = await createPostFixture({
        authorId: author.id,
        status: 'PUBLISHED',
        publishedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const res = await request(app).get('/api/v1/blog/posts').query({ limit: 100 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pageCount');

      const ids: string[] = res.body.items.map((p: { id: string }) => p.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(scheduled.id);
    });

    it('rejects an out-of-bounds limit with 400 VALIDATION_ERROR (DoS guard)', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/blog/posts').query({ limit: 100000 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toHaveProperty('limit');
    });
  });

  describe('GET /blog/posts/:slug — public, single published post', () => {
    it('returns 200 with the post for a genuinely live, published post', async () => {
      const app = createApp();
      const author = await createTestUser({ label: 'public-detail-author' });
      const live = await createPostFixture({
        authorId: author.id,
        status: 'PUBLISHED',
        publishedAt: new Date(Date.now() - 60_000),
      });

      const res = await request(app).get(`/api/v1/blog/posts/${live.slug}`);

      expect(res.status).toBe(200);
      expect(res.body.post).toMatchObject({ id: live.id, slug: live.slug });
      expect(res.body.post.author).toMatchObject({ id: author.id });
      // Never leaks internal author fields to anonymous visitors.
      expect(res.body.post.author).not.toHaveProperty('email');
      expect(res.body.post.author).not.toHaveProperty('passwordHash');
    });

    it(
      'returns 404 NOT_FOUND for a scheduled-but-not-yet-live post accessed directly by slug ' +
        '(must not leak via direct link, even though status === PUBLISHED)',
      async () => {
        const app = createApp();
        const author = await createTestUser({ label: 'public-detail-scheduled-author' });
        const scheduled = await createPostFixture({
          authorId: author.id,
          status: 'PUBLISHED',
          publishedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

        const res = await request(app).get(`/api/v1/blog/posts/${scheduled.slug}`);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
    );

    it('returns 404 NOT_FOUND for a DRAFT post (never published) — identical shape to "no such slug"', async () => {
      const app = createApp();
      const author = await createTestUser({ label: 'public-detail-draft-author' });
      const draft = await createPostFixture({ authorId: author.id, status: 'DRAFT' });

      const draftRes = await request(app).get(`/api/v1/blog/posts/${draft.slug}`);
      const missingRes = await request(app).get(`/api/v1/blog/posts/no-such-slug-${uniqueSuffix()}`);

      expect(draftRes.status).toBe(404);
      expect(missingRes.status).toBe(404);
      // Collapsed-outcome anti-enumeration guarantee: identical error shape
      // whether the slug exists-but-is-private or doesn't exist at all.
      expect(draftRes.body).toEqual(missingRes.body);
      expect(draftRes.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ===========================================================================
  // Admin routes — auth/role gating
  // ===========================================================================
  describe('admin routes — authentication/role gating', () => {
    it('rejects an anonymous caller on GET /admin/blog/posts with 401 UNAUTHORIZED', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/admin/blog/posts');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it(
      'rejects an authenticated EVENT_MANAGER (wrong role) on GET /admin/blog/posts with 403 FORBIDDEN',
      async () => {
        const app = createApp();
        const eventManager = await createTestUser({ label: 'wrong-role-event-manager', role: 'EVENT_MANAGER' });
        const agent = await loginAs(app, eventManager);

        const res = await agent.get('/api/v1/admin/blog/posts');

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // POST /admin/blog/posts — create
  // ===========================================================================
  describe('POST /admin/blog/posts', () => {
    it(
      'creates a DRAFT post with a generated slug and sanitized body for an authenticated Blogger (201)',
      async () => {
        const app = createApp();
        const blogger = await createTestUser({ label: 'create-blogger' });
        const agent = await loginAs(app, blogger);

        const res = await agent.post('/api/v1/admin/blog/posts').send({
          title: uniqueTitle('Create Flow'),
          body: '<p>Hello <script>alert(1)</script><strong onclick="x()">world</strong></p>',
        });

        expect(res.status).toBe(201);
        expect(res.body.post).toMatchObject({ status: 'DRAFT', authorId: blogger.id });
        expect(res.body.post.slug).toBeTruthy();
        expect(res.body.post.publishedAt).toBeNull();
        expect(res.body.post.body).not.toContain('<script');
        expect(res.body.post.body).not.toContain('onclick');
        expect(res.body.post.body).toContain('<strong>world</strong>');

        createdPostIds.push(res.body.post.id);
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a too-short title with 400 VALIDATION_ERROR carrying field-level detail',
      async () => {
        const app = createApp();
        const blogger = await createTestUser({ label: 'create-validation-blogger' });
        const agent = await loginAs(app, blogger);

        const res = await agent.post('/api/v1/admin/blog/posts').send({
          title: 'ab',
          body: '<p>A perfectly fine body of sufficient length.</p>',
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('title');
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // GET /admin/blog/posts — ownership-scoped listing
  // ===========================================================================
  describe('GET /admin/blog/posts — ownership-scoped listing', () => {
    it(
      "scopes a Blogger's list to only their own posts",
      async () => {
        const app = createApp();
        const blogger = await createTestUser({ label: 'list-scope-blogger' });
        const otherAuthor = await createTestUser({ label: 'list-scope-other-author' });

        const own = await createPostFixture({ authorId: blogger.id });
        const others = await createPostFixture({ authorId: otherAuthor.id });

        const agent = await loginAs(app, blogger);
        const res = await agent.get('/api/v1/admin/blog/posts').query({ limit: 100 });

        expect(res.status).toBe(200);
        const ids: string[] = res.body.items.map((p: { id: string }) => p.id);
        expect(ids).toContain(own.id);
        expect(ids).not.toContain(others.id);
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      "lets an Admin see every author's posts",
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'list-scope-admin', role: 'ADMIN' });
        const authorA = await createTestUser({ label: 'list-scope-author-a' });
        const authorB = await createTestUser({ label: 'list-scope-author-b' });

        const postA = await createPostFixture({ authorId: authorA.id });
        const postB = await createPostFixture({ authorId: authorB.id });

        const agent = await loginAs(app, admin);
        const res = await agent.get('/api/v1/admin/blog/posts').query({ limit: 100 });

        expect(res.status).toBe(200);
        const ids: string[] = res.body.items.map((p: { id: string }) => p.id);
        expect(ids).toContain(postA.id);
        expect(ids).toContain(postB.id);
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // Ownership enforcement on single-post mutation routes — the core
  // "Blogger cannot mutate another author's post by id" guarantee
  // ===========================================================================
  describe("ownership enforcement — Blogger cannot mutate another author's post by id", () => {
    it(
      'PATCH /admin/blog/posts/:id — 403 FORBIDDEN for a non-owning Blogger, post unchanged',
      async () => {
        const app = createApp();
        const owner = await createTestUser({ label: 'patch-owner' });
        const intruder = await createTestUser({ label: 'patch-intruder' });
        const post = await createPostFixture({ authorId: owner.id });

        const agent = await loginAs(app, intruder);
        const res = await agent.patch(`/api/v1/admin/blog/posts/${post.id}`).send({ title: 'Hostile Edit' });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');

        const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
        expect(reloaded?.title).toBe(post.title);
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'DELETE /admin/blog/posts/:id — 403 FORBIDDEN for a non-owning Blogger, post not deleted',
      async () => {
        const app = createApp();
        const owner = await createTestUser({ label: 'delete-owner' });
        const intruder = await createTestUser({ label: 'delete-intruder' });
        const post = await createPostFixture({ authorId: owner.id });

        const agent = await loginAs(app, intruder);
        const res = await agent.delete(`/api/v1/admin/blog/posts/${post.id}`);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');

        const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
        expect(reloaded).not.toBeNull();
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'POST /admin/blog/posts/:id/publish — 403 FORBIDDEN for a non-owning Blogger, status unchanged',
      async () => {
        const app = createApp();
        const owner = await createTestUser({ label: 'publish-owner' });
        const intruder = await createTestUser({ label: 'publish-intruder' });
        const post = await createPostFixture({ authorId: owner.id, status: 'DRAFT' });

        const agent = await loginAs(app, intruder);
        const res = await agent.post(`/api/v1/admin/blog/posts/${post.id}/publish`);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');

        const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
        expect(reloaded?.status).toBe('DRAFT');
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'POST /admin/blog/posts/:id/unpublish — 403 FORBIDDEN for a non-owning Blogger, status unchanged',
      async () => {
        const app = createApp();
        const owner = await createTestUser({ label: 'unpublish-owner' });
        const intruder = await createTestUser({ label: 'unpublish-intruder' });
        const post = await createPostFixture({
          authorId: owner.id,
          status: 'PUBLISHED',
          publishedAt: new Date(Date.now() - 60_000),
        });

        const agent = await loginAs(app, intruder);
        const res = await agent.post(`/api/v1/admin/blog/posts/${post.id}/unpublish`);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');

        const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
        expect(reloaded?.status).toBe('PUBLISHED');
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'an Admin MAY act on another author\'s post (PATCH succeeds with 200)',
      async () => {
        const app = createApp();
        const author = await createTestUser({ label: 'admin-can-edit-author' });
        const admin = await createTestUser({ label: 'admin-can-edit-admin', role: 'ADMIN' });
        const post = await createPostFixture({ authorId: author.id });

        const agent = await loginAs(app, admin);
        const res = await agent.patch(`/api/v1/admin/blog/posts/${post.id}`).send({ title: 'Admin Override Edit' });

        expect(res.status).toBe(200);
        expect(res.body.post.title).toBe('Admin Override Edit');
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND (not 403) for a nonexistent post id on every single-post mutation route',
      async () => {
        const app = createApp();
        const blogger = await createTestUser({ label: 'notfound-mutation-blogger' });
        const agent = await loginAs(app, blogger);
        const missingId = randomUUID();

        const patchRes = await agent.patch(`/api/v1/admin/blog/posts/${missingId}`).send({ title: 'whatever' });
        const deleteRes = await agent.delete(`/api/v1/admin/blog/posts/${missingId}`);
        const publishRes = await agent.post(`/api/v1/admin/blog/posts/${missingId}/publish`);
        const unpublishRes = await agent.post(`/api/v1/admin/blog/posts/${missingId}/unpublish`);

        for (const res of [patchRes, deleteRes, publishRes, unpublishRes]) {
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // Publish/unpublish — happy path for the owning author
  // ===========================================================================
  describe('publish/unpublish — owning author happy path', () => {
    it(
      'publish transitions DRAFT -> PUBLISHED, stamping publishedAt and preserving the slug',
      async () => {
        const app = createApp();
        const author = await createTestUser({ label: 'publish-happy-author' });
        const post = await createPostFixture({ authorId: author.id, status: 'DRAFT' });
        const agent = await loginAs(app, author);

        const res = await agent.post(`/api/v1/admin/blog/posts/${post.id}/publish`);

        expect(res.status).toBe(200);
        expect(res.body.post).toMatchObject({ id: post.id, status: 'PUBLISHED', slug: post.slug });
        expect(res.body.post.publishedAt).not.toBeNull();
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'unpublish transitions PUBLISHED -> DRAFT, preserving slug and publishedAt history',
      async () => {
        const app = createApp();
        const author = await createTestUser({ label: 'unpublish-happy-author' });
        const publishedAt = new Date(Date.now() - 60_000);
        const post = await createPostFixture({ authorId: author.id, status: 'PUBLISHED', publishedAt });
        const agent = await loginAs(app, author);

        const res = await agent.post(`/api/v1/admin/blog/posts/${post.id}/unpublish`);

        expect(res.status).toBe(200);
        expect(res.body.post).toMatchObject({ id: post.id, status: 'DRAFT', slug: post.slug });
        expect(res.body.post.publishedAt).not.toBeNull();
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // PATCH /admin/blog/posts/:id/slug — Admin-only manual slug edit
  // ===========================================================================
  describe('PATCH /admin/blog/posts/:id/slug — Admin-only manual slug edit', () => {
    it(
      'rejects a Blogger (even the post\'s own author) with 403 FORBIDDEN — this route is Admin-only',
      async () => {
        const app = createApp();
        const author = await createTestUser({ label: 'slug-route-author-blocked' });
        const post = await createPostFixture({ authorId: author.id });
        const agent = await loginAs(app, author);

        const res = await agent
          .patch(`/api/v1/admin/blog/posts/${post.id}/slug`)
          .send({ slug: `author-attempted-rename-${uniqueSuffix()}` });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');

        const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
        expect(reloaded?.slug).toBe(post.slug);
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an Admin to set a fresh, valid slug on ANY post (200)',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'slug-route-admin', role: 'ADMIN' });
        const author = await createTestUser({ label: 'slug-route-author' });
        const post = await createPostFixture({ authorId: author.id });
        const agent = await loginAs(app, admin);

        const newSlug = `admin-renamed-${uniqueSuffix()}`;
        const res = await agent.patch(`/api/v1/admin/blog/posts/${post.id}/slug`).send({ slug: newSlug });

        expect(res.status).toBe(200);
        expect(res.body.post.slug).toBe(newSlug);
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a malformed slug (uppercase/spaces) with 400 VALIDATION_ERROR before reaching the service',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'slug-route-malformed-admin', role: 'ADMIN' });
        const author = await createTestUser({ label: 'slug-route-malformed-author' });
        const post = await createPostFixture({ authorId: author.id });
        const agent = await loginAs(app, admin);

        const res = await agent
          .patch(`/api/v1/admin/blog/posts/${post.id}/slug`)
          .send({ slug: 'Not A Valid Slug!' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('slug');
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // DELETE — owning author happy path
  // ===========================================================================
  describe('DELETE /admin/blog/posts/:id — owning author happy path', () => {
    it(
      'deletes the post (204) and it is genuinely gone afterward',
      async () => {
        const app = createApp();
        const author = await createTestUser({ label: 'delete-happy-author' });
        const post = await createPostFixture({ authorId: author.id });
        const agent = await loginAs(app, author);

        const res = await agent.delete(`/api/v1/admin/blog/posts/${post.id}`);
        expect(res.status).toBe(204);

        createdPostIds = createdPostIds.filter((id) => id !== post.id);

        const reloaded = await db.blogPost.findUnique({ where: { id: post.id } });
        expect(reloaded).toBeNull();
      },
      BLOG_ROUTER_TEST_TIMEOUT_MS,
    );
  });
});
