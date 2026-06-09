/**
 * `User` repository (plan.md Phase 4f) — the persistence layer in this
 * module's router -> service -> repository chain (architecture.md §6 "Clean
 * layering"). Owns ALL direct Prisma access for `User` records within the
 * Users module; the service composes these primitives and applies every domain
 * rule on top (last-Admin lockout check, self-lock prevention, temp-password
 * generation, `passwordHash` stripping before returning). No business logic
 * lives here — only typed, named queries, mirroring the factory-based shape
 * of every other module's repository (`createCmsRepository({ db })`, etc.).
 *
 * NOTE: `passwordHash` is NEVER included in the return types exposed here to
 * callers outside this module — `AdminUserView` (defined in `users.service.ts`)
 * is the safe, serializable shape every consumer receives. The repository
 * methods that fetch user rows return the raw Prisma `User` objects internally
 * so the service can verify/use the hash where needed (e.g. during login,
 * though that is `AuthService`'s domain — here it's only needed for the
 * `passwordHash` field that gets stored on creation), but the service is
 * responsible for stripping it before returning anything to the router.
 */
import type { Prisma, PrismaClient, Role, User } from '@prisma/client';

import type { PaginationQuery } from '../../lib/pagination';
import { toSkipTake, toPaginatedResult, type PaginatedResult } from '../../lib/pagination';

export interface UsersRepositoryOptions {
  db: PrismaClient;
}

export interface ListUsersFilter {
  role?: Role;
  isActive?: boolean;
}

export interface UsersRepository {
  /**
   * Paginated list of users, optionally filtered by `role` and/or `isActive`.
   * Returns the raw Prisma `User` shape (including `passwordHash`) — the
   * service layer strips sensitive fields before returning to the router.
   */
  list(filter: ListUsersFilter, pagination: PaginationQuery): Promise<PaginatedResult<User>>;

  /**
   * Finds a single user by id. Returns `null` if not found — the service
   * translates `null` into `notFound()`.
   */
  findById(id: string): Promise<User | null>;

  /**
   * Finds a single user by email (case-sensitive, matches the `@unique`
   * index). Returns `null` if not found — used for duplicate-email detection
   * in `createUser`.
   */
  findByEmail(email: string): Promise<User | null>;

  /**
   * Creates a new `User` row. The `passwordHash` field must be pre-computed
   * by the service before calling this method — the repository never hashes
   * passwords itself (mirroring the "takes the already-hashed credential"
   * convention `auth.service.ts` establishes for user creation).
   */
  create(data: {
    name: string;
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<User>;

  /**
   * Partially updates a user row. Only the fields explicitly present in
   * `data` are changed — `undefined` fields are ignored by Prisma's `update`
   * semantics (Prisma omits `undefined` values from the generated SQL).
   */
  update(id: string, data: { role?: Role; email?: string; isActive?: boolean }): Promise<User>;

  /**
   * Count of currently active Admins — used by the service's last-Admin
   * lockout-prevention check. A dedicated method (rather than `list(...)` +
   * `.total`) because this count is queried in the hot path of every PATCH
   * that touches a role or `isActive` field on an Admin account, and a
   * targeted `count` query is an order of magnitude cheaper than a full
   * `findMany` for this single-number guard.
   */
  countActiveAdmins(): Promise<number>;
}

export function createUsersRepository({ db }: UsersRepositoryOptions): UsersRepository {
  return {
    async list(filter, pagination) {
      const where: Prisma.UserWhereInput = {};
      if (filter.role !== undefined) {
        where.role = filter.role;
      }
      if (filter.isActive !== undefined) {
        where.isActive = filter.isActive;
      }

      const { skip, take } = toSkipTake(pagination);

      const [users, total] = await db.$transaction([
        db.user.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
        }),
        db.user.count({ where }),
      ]);

      return toPaginatedResult(users, pagination, total);
    },

    async findById(id) {
      return db.user.findUnique({ where: { id } });
    },

    async findByEmail(email) {
      return db.user.findUnique({ where: { email } });
    },

    async create(data) {
      return db.user.create({ data });
    },

    async update(id, data) {
      return db.user.update({
        where: { id },
        data,
      });
    },

    async countActiveAdmins() {
      return db.user.count({ where: { role: 'ADMIN', isActive: true } });
    },
  };
}
