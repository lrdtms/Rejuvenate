/**
 * Unit tests for `canEditPost` (plan.md Phase 3 step 6).
 *
 * Pure-function unit tests — `canEditPost` takes plain data and returns a
 * `boolean`; no mocking, no database, no Express. The thing worth pinning
 * down precisely is the AUTHOR-vs-ADMIN decision matrix the brief calls out
 * by name, expressed as a single legible table (mirrors `rbac.test.ts`'s
 * matrix-table convention for the equivalent "decision matrix" shape).
 */
import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from './auth.service';
import { canEditPost, type OwnedPost } from './ownership';

function userOf(overrides: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: 'user-1',
    name: 'Test User',
    email: 'test-user@example.invalid',
    role: 'BLOGGER',
    isActive: true,
    ...overrides,
  };
}

function postOf(authorId: string): OwnedPost {
  return { authorId };
}

describe('canEditPost (plan.md Phase 3 step 6 — "Bloggers manage own posts only" default)', () => {
  const matrix: Array<{
    description: string;
    user: AuthenticatedUser;
    post: OwnedPost;
    expected: boolean;
  }> = [
    {
      description: 'Blogger editing their OWN post -> allowed',
      user: userOf({ id: 'blogger-1', role: 'BLOGGER' }),
      post: postOf('blogger-1'),
      expected: true,
    },
    {
      description: "Blogger editing ANOTHER author's post -> denied (the documented default)",
      user: userOf({ id: 'blogger-1', role: 'BLOGGER' }),
      post: postOf('blogger-2'),
      expected: false,
    },
    {
      description: 'Admin editing ANY post (not their own) -> allowed (Admin override)',
      user: userOf({ id: 'admin-1', role: 'ADMIN' }),
      post: postOf('blogger-2'),
      expected: true,
    },
    {
      description: 'Admin editing their OWN post -> allowed (both clauses true; still allowed)',
      user: userOf({ id: 'admin-1', role: 'ADMIN' }),
      post: postOf('admin-1'),
      expected: true,
    },
    {
      description:
        'Event Manager attempting to edit a post authored by someone else -> denied ' +
        '(no Admin override, no authorId match — the only two ways in)',
      user: userOf({ id: 'event-manager-1', role: 'EVENT_MANAGER' }),
      post: postOf('blogger-2'),
      expected: false,
    },
    {
      description:
        "Event Manager whose id happens to match a post's authorId -> allowed by THIS predicate " +
        '(canEditPost is a pure ownership/Admin-override check — it intentionally does not encode ' +
        '"Event Managers have no blog access" -> that is requireRole\'s job at the ROUTE layer, ' +
        "per architecture.md §9.2's RBAC matrix; in practice an Event Manager never reaches this " +
        "check because requireRole('ADMIN','BLOGGER') rejects them first. This case exists to " +
        'document that boundary precisely, not to suggest it is exploitable.)',
      user: userOf({ id: 'event-manager-1', role: 'EVENT_MANAGER' }),
      post: postOf('event-manager-1'),
      expected: true,
    },
  ];

  it.each(matrix)('$description', ({ user, post, expected }) => {
    expect(canEditPost(user, post)).toBe(expected);
  });

  it('accepts a minimal projection exposing only authorId (not a full BlogPost row)', () => {
    const user = userOf({ id: 'blogger-1' });
    // Exactly the `OwnedPost` shape — proves callers don't need to fetch/pass
    // a full Prisma `BlogPost` for an authorization pre-check.
    const minimalPost: OwnedPost = { authorId: 'blogger-1' };

    expect(canEditPost(user, minimalPost)).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const user = userOf({ id: 'blogger-1' });
    const post = postOf('blogger-1');
    const userSnapshot = { ...user };
    const postSnapshot = { ...post };

    canEditPost(user, post);

    expect(user).toEqual(userSnapshot);
    expect(post).toEqual(postSnapshot);
  });
});
