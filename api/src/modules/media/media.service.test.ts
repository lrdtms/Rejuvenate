/**
 * Integration tests for `MediaService` (plan.md Phase 4e).
 *
 * Exercised against the REAL local Postgres via the real repositories —
 * mirroring the established pattern in `blog.service.test.ts` /
 * `cms.service.test.ts` (no DB-mocking infrastructure exists; standing one
 * up purely for these assertions would be more machinery than it's worth).
 *
 * Each test creates its own throwaway `User`/`BlogPost`/`Event` fixtures with
 * unique, randomly-suffixed values and cleans them up in `afterEach`.
 *
 * ===========================================================================
 * File-system tests use a temp directory
 * ===========================================================================
 * All tests that write files use a `os.tmpdir()`-based temp directory as
 * the upload dir (never `api/uploads/`) so they run cleanly on any machine
 * without leaving artifacts. The temp dir is created per-suite and cleaned
 * up in `afterAll`.
 *
 * ===========================================================================
 * Critical tests (called out in plan.md Phase 4e)
 * ===========================================================================
 *   1. FITNESS FUNCTION: after `BlogService.deletePost`/`EventService.deleteEvent`,
 *      NO `MediaAsset` rows for the deleted owner remain — the ADR-0005 integrity
 *      guarantee (no DB-level FK cascade; must be enforced in the service layer).
 *   2. Content-sniffed MIME: a file with `.jpg` extension but PDF magic bytes
 *      is rejected.
 *   3. Ownership: Blogger can't upload to another Blogger's post; Blogger can't
 *      upload to an Event; EventManager can't upload to a BlogPost; Admin can
 *      upload to either.
 *   4. Cascading delete: after `deletePost`, associated MediaAsset rows are gone
 *      and files are unlinked from disk.
 *   5. EXIF stripping: the service runs the buffer through sharp before writing.
 *   6. Size cap: a file over MAX_FILE_SIZE_BYTES is rejected with badRequest.
 *   7. URL scheme: returned `url` starts with `/media/` and the stored filename
 *      is NOT the original client filename.
 */
import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../../lib/db';
import type { AuthenticatedUser } from '../auth/auth.service';
import { createBlogRepository } from '../blog/blog.repository';
import { createBlogService } from '../blog/blog.service';
import { createEventRepository } from '../events/events.repository';
import { createEventService } from '../events/events.service';
import { createMediaRepository } from './media.repository';
import { createMediaService, type MediaService } from './media.service';
import { MAX_FILE_SIZE_BYTES, MEDIA_URL_PREFIX } from './media.constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSuffix(): string {
  return randomUUID();
}

/** Creates a minimal 1x1 JPEG buffer via sharp — a valid image file for tests
 * that need to pass the content-sniffed MIME check and sharp processing. */
async function makeMinimalJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
}

/** Creates a minimal 1x1 PNG buffer via sharp. */
async function makeMinimalPng(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** Creates a buffer that starts with PDF magic bytes (`%PDF`) — used for the
 * "content-sniffed rejection" test: a file named `evil.jpg` but with PDF bytes
 * must be rejected by the content-sniffed MIME check, not by the extension. */
function makePdfMagicBuffer(): Buffer {
  // %PDF-1.4 magic bytes followed by filler
  return Buffer.from('%PDF-1.4\n%%fake content for testing\n', 'ascii');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let createdUserIds: string[] = [];
let createdPostIds: string[] = [];
let createdEventIds: string[] = [];
let createdAssetIds: string[] = [];

beforeAll(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'rejuvenate-media-test-'));
});

afterAll(async () => {
  // Clean up temp directory and all its contents
  await fsPromises.rm(tempDir, { recursive: true, force: true });
});

afterEach(async () => {
  if (createdAssetIds.length > 0) {
    await db.mediaAsset.deleteMany({ where: { id: { in: createdAssetIds } } });
    createdAssetIds = [];
  }
  if (createdPostIds.length > 0) {
    await db.blogPost.deleteMany({ where: { id: { in: createdPostIds } } });
    createdPostIds = [];
  }
  if (createdEventIds.length > 0) {
    await db.event.deleteMany({ where: { id: { in: createdEventIds } } });
    createdEventIds = [];
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
}): Promise<AuthenticatedUser> {
  const { label, role = 'BLOGGER' } = opts;
  const created = await db.user.create({
    data: {
      name: `Media Test User (${label})`,
      email: `media-test-${label}-${uniqueSuffix()}@example.invalid`,
      passwordHash: 'not-a-real-hash',
      role,
      isActive: true,
    },
  });
  createdUserIds.push(created.id);
  return { id: created.id, name: created.name, email: created.email, role: created.role, isActive: true };
}

async function createDraftPost(author: AuthenticatedUser) {
  const post = await db.blogPost.create({
    data: {
      title: `Media Test Post ${uniqueSuffix()}`,
      slug: `media-test-post-${uniqueSuffix()}`,
      body: '<p>test</p>',
      authorId: author.id,
      status: 'DRAFT',
    },
  });
  createdPostIds.push(post.id);
  return post;
}

async function createDraftEvent(creator: AuthenticatedUser) {
  const now = new Date();
  const event = await db.event.create({
    data: {
      title: `Media Test Event ${uniqueSuffix()}`,
      slug: `media-test-event-${uniqueSuffix()}`,
      description: 'Test event for media tests',
      startsAt: new Date(now.getTime() + 86400 * 1000),
      endsAt: new Date(now.getTime() + 2 * 86400 * 1000),
      branch: 'CAPE_TOWN',
      locationDetail: 'Test venue',
      status: 'DRAFT',
      createdById: creator.id,
    },
  });
  createdEventIds.push(event.id);
  return event;
}

/** Creates a `MediaService` instance wired to the real DB and the given temp dir. */
function makeService(overrideUploadDir?: string): MediaService {
  const blogRepository = createBlogRepository({ db });
  const eventRepository = createEventRepository({ db });
  const mediaRepository = createMediaRepository({ db });

  return createMediaService({
    repository: mediaRepository,
    blogRepository,
    eventRepository,
    uploadDir: overrideUploadDir ?? tempDir,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaService.upload', () => {
  it('stores a valid JPEG, strips EXIF, and returns a MediaAsset with a /media/ URL', async () => {
    const service = makeService();
    const author = await createTestUser({ label: 'blogger-upload', role: 'BLOGGER' });
    const post = await createDraftPost(author);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      author,
      { buffer: jpegBuffer, originalname: 'my-photo.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'Test image', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);

    // URL scheme test: starts with /media/, NOT the original filename
    expect(asset.url).toMatch(/^\/media\//);
    expect(asset.url).not.toContain('my-photo.jpg');

    // The stored filename is a UUID + extension, not the original name
    const storedFilename = path.basename(asset.url);
    expect(storedFilename).toMatch(/^[0-9a-f-]{36}\.jpg$/);

    // The file actually exists on disk
    const filePath = path.join(tempDir, storedFilename);
    const stat = await fsPromises.stat(filePath);
    expect(stat.isFile()).toBe(true);

    // The asset row has correct fields
    expect(asset.ownerType).toBe('BLOG_POST');
    expect(asset.ownerId).toBe(post.id);
    expect(asset.altText).toBe('Test image');
    expect(asset.sortOrder).toBe(0);
  });

  it('accepts a valid PNG file', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'admin-png', role: 'ADMIN' });
    const post = await createDraftPost(admin);
    const pngBuffer = await makeMinimalPng();

    const asset = await service.upload(
      admin,
      { buffer: pngBuffer, originalname: 'image.png' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'PNG test', sortOrder: 1 },
    );

    createdAssetIds.push(asset.id);
    expect(asset.url).toMatch(/^\/media\//);
    const storedFilename = path.basename(asset.url);
    expect(storedFilename).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  // -------------------------------------------------------------------------
  // TEST 2: Content-sniffed MIME rejection
  // -------------------------------------------------------------------------
  it('rejects a file with .jpg extension but PDF magic bytes (content-sniffed, not header-trusted)', async () => {
    const service = makeService();
    const author = await createTestUser({ label: 'evil-jpg', role: 'BLOGGER' });
    const post = await createDraftPost(author);
    const pdfBuffer = makePdfMagicBuffer();

    const filesBefore = (await fsPromises.readdir(tempDir)).length;

    await expect(
      service.upload(
        author,
        { buffer: pdfBuffer, originalname: 'evil.jpg' }, // .jpg extension, PDF bytes
        { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'evil', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Confirm no NEW file was written to disk during this rejected upload
    const filesAfter = (await fsPromises.readdir(tempDir)).length;
    expect(filesAfter).toBe(filesBefore);
  });

  // -------------------------------------------------------------------------
  // TEST 6: Size cap
  // -------------------------------------------------------------------------
  it('rejects a file over MAX_FILE_SIZE_BYTES with BAD_REQUEST', async () => {
    const service = makeService();
    const author = await createTestUser({ label: 'big-file', role: 'BLOGGER' });
    const post = await createDraftPost(author);

    // Buffer just over the limit — content doesn't matter (size check is first)
    const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 0);

    await expect(
      service.upload(
        author,
        { buffer: oversized, originalname: 'huge.jpg' },
        { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'too big', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // -------------------------------------------------------------------------
  // TEST 3a: Blogger can't upload to another Blogger's post
  // -------------------------------------------------------------------------
  it('rejects a Blogger uploading to another Blogger\'s post (ownership check)', async () => {
    const service = makeService();
    const owner = await createTestUser({ label: 'post-owner', role: 'BLOGGER' });
    const attacker = await createTestUser({ label: 'attacker', role: 'BLOGGER' });
    const post = await createDraftPost(owner);
    const jpegBuffer = await makeMinimalJpeg();

    await expect(
      service.upload(
        attacker,
        { buffer: jpegBuffer, originalname: 'hack.jpg' },
        { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'not mine', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // -------------------------------------------------------------------------
  // TEST 3b: Blogger can't upload to an Event
  // -------------------------------------------------------------------------
  it('rejects a Blogger uploading to an Event (wrong content area)', async () => {
    const service = makeService();
    const blogger = await createTestUser({ label: 'blogger-event', role: 'BLOGGER' });
    const eventManager = await createTestUser({ label: 'em-for-event', role: 'EVENT_MANAGER' });
    const event = await createDraftEvent(eventManager);
    const jpegBuffer = await makeMinimalJpeg();

    await expect(
      service.upload(
        blogger,
        { buffer: jpegBuffer, originalname: 'nope.jpg' },
        { ownerType: 'EVENT', ownerId: event.id, altText: 'not allowed', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // -------------------------------------------------------------------------
  // TEST 3c: EventManager can't upload to a BlogPost
  // -------------------------------------------------------------------------
  it('rejects an EventManager uploading to a BlogPost (wrong content area)', async () => {
    const service = makeService();
    const blogger = await createTestUser({ label: 'post-author', role: 'BLOGGER' });
    const em = await createTestUser({ label: 'em-blog', role: 'EVENT_MANAGER' });
    const post = await createDraftPost(blogger);
    const jpegBuffer = await makeMinimalJpeg();

    await expect(
      service.upload(
        em,
        { buffer: jpegBuffer, originalname: 'nope.jpg' },
        { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'not allowed', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // -------------------------------------------------------------------------
  // TEST 3d: Admin can upload to either a BlogPost or an Event
  // -------------------------------------------------------------------------
  it('allows Admin to upload to a BlogPost', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'admin-blog', role: 'ADMIN' });
    const blogger = await createTestUser({ label: 'blog-author', role: 'BLOGGER' });
    const post = await createDraftPost(blogger);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'admin-upload.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'Admin blog upload', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);
    expect(asset.ownerType).toBe('BLOG_POST');
  });

  it('allows Admin to upload to an Event', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'admin-event', role: 'ADMIN' });
    const event = await createDraftEvent(admin);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'admin-event-upload.jpg' },
      { ownerType: 'EVENT', ownerId: event.id, altText: 'Admin event upload', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);
    expect(asset.ownerType).toBe('EVENT');
  });

  // -------------------------------------------------------------------------
  // TEST 3e: EventManager can upload to an Event they didn't create
  // -------------------------------------------------------------------------
  it('allows an EventManager to upload to any event (no per-event ownership scope)', async () => {
    const service = makeService();
    const em1 = await createTestUser({ label: 'em1', role: 'EVENT_MANAGER' });
    const em2 = await createTestUser({ label: 'em2', role: 'EVENT_MANAGER' });
    const event = await createDraftEvent(em1); // created by em1
    const jpegBuffer = await makeMinimalJpeg();

    // em2 (different Event Manager) uploads to em1's event — should succeed
    const asset = await service.upload(
      em2,
      { buffer: jpegBuffer, originalname: 'em2-upload.jpg' },
      { ownerType: 'EVENT', ownerId: event.id, altText: 'EM2 upload', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);
    expect(asset.ownerType).toBe('EVENT');
  });

  it('returns NOT_FOUND when ownerId references a non-existent BlogPost', async () => {
    const service = makeService();
    const author = await createTestUser({ label: 'no-post', role: 'BLOGGER' });
    const jpegBuffer = await makeMinimalJpeg();

    await expect(
      service.upload(
        author,
        { buffer: jpegBuffer, originalname: 'test.jpg' },
        { ownerType: 'BLOG_POST', ownerId: randomUUID(), altText: 'ghost', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns NOT_FOUND when ownerId references a non-existent Event', async () => {
    const service = makeService();
    const em = await createTestUser({ label: 'no-event', role: 'EVENT_MANAGER' });
    const jpegBuffer = await makeMinimalJpeg();

    await expect(
      service.upload(
        em,
        { buffer: jpegBuffer, originalname: 'test.jpg' },
        { ownerType: 'EVENT', ownerId: randomUUID(), altText: 'ghost', sortOrder: 0 },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // TEST 5: EXIF stripping — verify sharp processes the file
  // -------------------------------------------------------------------------
  it('strips EXIF metadata (verifies sharp output has no EXIF metadata)', async () => {
    // Build a JPEG with fake EXIF bytes injected (just enough to check that
    // the OUTPUT from sharp has no EXIF segment — we verify by reading the
    // output with sharp itself and checking metadata is empty).
    const service = makeService();
    const admin = await createTestUser({ label: 'exif-test', role: 'ADMIN' });
    const post = await createDraftPost(admin);

    // A minimal JPEG with a GPS coordinate embedded via sharp's withMetadata
    const jpegWithExif = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'GPS:52.3,-0.1' } } })
      .toBuffer();

    const asset = await service.upload(
      admin,
      { buffer: jpegWithExif, originalname: 'with-exif.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'EXIF test', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);

    // Read the stored file back with sharp and check metadata
    const storedFilename = path.basename(asset.url);
    const storedPath = path.join(tempDir, storedFilename);
    const meta = await sharp(storedPath).metadata();

    // After sharp strips metadata, there should be no EXIF IFD0 data
    // (sharp's metadata() returns `exif` as a Buffer if present, or undefined)
    expect(meta.exif).toBeUndefined();
  });
});

describe('MediaService.deleteAsset', () => {
  it('deletes the DB row and unlinks the file from disk', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'delete-test', role: 'ADMIN' });
    const post = await createDraftPost(admin);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'to-delete.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'delete me', sortOrder: 0 },
    );

    const storedFilename = path.basename(asset.url);
    const filePath = path.join(tempDir, storedFilename);

    // File exists before delete
    await expect(fsPromises.stat(filePath)).resolves.toBeDefined();

    await service.deleteAsset(admin, asset.id);

    // File gone from disk
    await expect(fsPromises.stat(filePath)).rejects.toThrow(/ENOENT/);

    // Row gone from DB
    const row = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(row).toBeNull();
  });

  it('succeeds (deletes DB row) even if the file is already gone from disk (ENOENT ignored)', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'enoent-test', role: 'ADMIN' });
    const post = await createDraftPost(admin);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'already-gone.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'already gone', sortOrder: 0 },
    );

    // Manually delete the file first
    const storedFilename = path.basename(asset.url);
    await fsPromises.unlink(path.join(tempDir, storedFilename));

    // deleteAsset should succeed even with the file gone
    await expect(service.deleteAsset(admin, asset.id)).resolves.not.toThrow();

    const row = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(row).toBeNull();
  });

  it('throws NOT_FOUND for a non-existent asset id', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'not-found-delete', role: 'ADMIN' });

    await expect(service.deleteAsset(admin, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a Blogger deleting another Blogger\'s asset', async () => {
    const service = makeService();
    const owner = await createTestUser({ label: 'asset-owner', role: 'BLOGGER' });
    const attacker = await createTestUser({ label: 'attacker-del', role: 'BLOGGER' });
    const post = await createDraftPost(owner);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      owner,
      { buffer: jpegBuffer, originalname: 'owned.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'owned', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);

    await expect(service.deleteAsset(attacker, asset.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('MediaService.listByOwner', () => {
  it('returns assets for an owner, ordered by sortOrder', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'list-test', role: 'ADMIN' });
    const post = await createDraftPost(admin);
    const jpegBuffer = await makeMinimalJpeg();

    const a2 = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'a2.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'second', sortOrder: 2 },
    );
    const a1 = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'a1.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'first', sortOrder: 1 },
    );

    createdAssetIds.push(a1.id, a2.id);

    const result = await service.listByOwner(admin, 'BLOG_POST', post.id);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.sortOrder).toBe(1);
    expect(result.items[1]!.sortOrder).toBe(2);
  });

  it('returns empty array for an owner with no assets', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'list-empty', role: 'ADMIN' });
    const post = await createDraftPost(admin);

    const result = await service.listByOwner(admin, 'BLOG_POST', post.id);
    expect(result.items).toHaveLength(0);
  });

  it('rejects a Blogger listing assets for another Blogger\'s post', async () => {
    const service = makeService();
    const owner = await createTestUser({ label: 'list-owner', role: 'BLOGGER' });
    const other = await createTestUser({ label: 'list-other', role: 'BLOGGER' });
    const post = await createDraftPost(owner);

    await expect(service.listByOwner(other, 'BLOG_POST', post.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// ---------------------------------------------------------------------------
// FITNESS FUNCTION TEST (plan.md Phase 4e step 2 / architecture.md §15):
// After BlogService.deletePost / EventService.deleteEvent, NO MediaAsset rows
// for the deleted owner must remain. This is the ADR-0005 integrity guarantee.
// ---------------------------------------------------------------------------

describe('FITNESS FUNCTION: cascading delete — no orphaned MediaAsset rows after parent delete', () => {
  it('[BLOG] BlogService.deletePost cleans up associated MediaAsset rows and files', async () => {
    const blogRepository = createBlogRepository({ db });
    const eventRepository = createEventRepository({ db });
    const mediaRepository = createMediaRepository({ db });
    const mediaService = createMediaService({
      repository: mediaRepository,
      blogRepository,
      eventRepository,
      uploadDir: tempDir,
    });
    const blogService = createBlogService({ repository: blogRepository, mediaService });

    const author = await createTestUser({ label: 'cascade-blog', role: 'BLOGGER' });
    const post = await createDraftPost(author);
    const jpegBuffer = await makeMinimalJpeg();

    // Upload two assets for this post
    const a1 = await mediaService.upload(
      author,
      { buffer: jpegBuffer, originalname: 'cascade1.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'cascade 1', sortOrder: 0 },
    );
    const a2 = await mediaService.upload(
      author,
      { buffer: jpegBuffer, originalname: 'cascade2.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'cascade 2', sortOrder: 1 },
    );

    const file1 = path.join(tempDir, path.basename(a1.url));
    const file2 = path.join(tempDir, path.basename(a2.url));

    // Files exist before delete
    await expect(fsPromises.stat(file1)).resolves.toBeDefined();
    await expect(fsPromises.stat(file2)).resolves.toBeDefined();

    // Delete the post — this should trigger the cascade
    await blogService.deletePost(author, post.id);
    // Post is gone — remove from cleanup tracking
    createdPostIds = createdPostIds.filter((id) => id !== post.id);

    // FITNESS FUNCTION ASSERTION: zero MediaAsset rows reference this post
    const orphanCount = await db.mediaAsset.count({
      where: { ownerType: 'BLOG_POST', ownerId: post.id },
    });
    expect(orphanCount).toBe(0);

    // Files are also gone from disk
    await expect(fsPromises.stat(file1)).rejects.toThrow(/ENOENT/);
    await expect(fsPromises.stat(file2)).rejects.toThrow(/ENOENT/);
  });

  it('[EVENT] EventService.deleteEvent cleans up associated MediaAsset rows and files', async () => {
    const blogRepository = createBlogRepository({ db });
    const eventRepository = createEventRepository({ db });
    const mediaRepository = createMediaRepository({ db });
    const mediaService = createMediaService({
      repository: mediaRepository,
      blogRepository,
      eventRepository,
      uploadDir: tempDir,
    });
    const eventService = createEventService({ repository: eventRepository, mediaService });

    const admin = await createTestUser({ label: 'cascade-event', role: 'ADMIN' });
    const event = await createDraftEvent(admin);
    const jpegBuffer = await makeMinimalJpeg();

    // Upload two assets for this event
    const a1 = await mediaService.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'event-cascade1.jpg' },
      { ownerType: 'EVENT', ownerId: event.id, altText: 'event cascade 1', sortOrder: 0 },
    );
    const a2 = await mediaService.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'event-cascade2.jpg' },
      { ownerType: 'EVENT', ownerId: event.id, altText: 'event cascade 2', sortOrder: 1 },
    );

    const file1 = path.join(tempDir, path.basename(a1.url));
    const file2 = path.join(tempDir, path.basename(a2.url));

    // Files exist before delete
    await expect(fsPromises.stat(file1)).resolves.toBeDefined();
    await expect(fsPromises.stat(file2)).resolves.toBeDefined();

    // Delete the event — this should trigger the cascade
    await eventService.deleteEvent(admin, event.id);
    // Event is gone — remove from cleanup tracking
    createdEventIds = createdEventIds.filter((id) => id !== event.id);

    // FITNESS FUNCTION ASSERTION: zero MediaAsset rows reference this event
    const orphanCount = await db.mediaAsset.count({
      where: { ownerType: 'EVENT', ownerId: event.id },
    });
    expect(orphanCount).toBe(0);

    // Files are also gone from disk
    await expect(fsPromises.stat(file1)).rejects.toThrow(/ENOENT/);
    await expect(fsPromises.stat(file2)).rejects.toThrow(/ENOENT/);
  });
});

describe('MediaService.cascadeDeleteForOwner', () => {
  it('silently succeeds when there are no assets for the owner', async () => {
    const service = makeService();
    await expect(
      service.cascadeDeleteForOwner('BLOG_POST', randomUUID()),
    ).resolves.not.toThrow();
  });

  it('handles ENOENT on file unlink without throwing', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'cascade-enoent', role: 'ADMIN' });
    const post = await createDraftPost(admin);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'cascade-enoent.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'enoent cascade', sortOrder: 0 },
    );

    // Manually delete the file from disk first
    await fsPromises.unlink(path.join(tempDir, path.basename(asset.url)));

    // cascadeDeleteForOwner should still succeed (ENOENT ignored)
    await expect(
      service.cascadeDeleteForOwner('BLOG_POST', post.id),
    ).resolves.not.toThrow();

    // DB row is gone
    const row = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(row).toBeNull();
  });
});

describe('MediaService URL scheme', () => {
  it('returns a relative URL starting with /media/ and uses a UUID filename, not the original name', async () => {
    const service = makeService();
    const admin = await createTestUser({ label: 'url-scheme', role: 'ADMIN' });
    const post = await createDraftPost(admin);
    const jpegBuffer = await makeMinimalJpeg();

    const asset = await service.upload(
      admin,
      { buffer: jpegBuffer, originalname: 'my-original-photo.jpg' },
      { ownerType: 'BLOG_POST', ownerId: post.id, altText: 'URL test', sortOrder: 0 },
    );

    createdAssetIds.push(asset.id);

    // Relative URL, not absolute
    expect(asset.url).not.toMatch(/^https?:\/\//);
    // Starts with /media/
    expect(asset.url.startsWith(MEDIA_URL_PREFIX + '/')).toBe(true);
    // Does NOT contain the original filename
    expect(asset.url).not.toContain('my-original-photo');
    // Filename is UUID-based
    const filename = path.basename(asset.url);
    expect(filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/);
  });
});
