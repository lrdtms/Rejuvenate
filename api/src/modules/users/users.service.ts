/**
 * `UsersService` (plan.md Phase 4f step 2) — the use-case / business-rules
 * layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"). Owns every domain decision the
 * router must never make directly: duplicate-email rejection, temporary-
 * password generation and hashing, last-Admin lockout prevention, self-lock
 * prevention, `passwordHash` stripping from all returned shapes, and the
 * welcome-email dispatch on account creation.
 *
 * Constructed via a factory (`createUsersService({ repository, mailService,
 * logger })`) — the same dependency-injection convention as
 * `createAuthService`/`createCmsService`/`createBlogService`.
 *
 * ===========================================================================
 * `AdminUserView` — the safe, serializable shape (never exposes `passwordHash`)
 * ===========================================================================
 * Every method that returns user data returns `AdminUserView` (or
 * `PaginatedResult<AdminUserView>`) — never the raw Prisma `User` row.
 * `passwordHash` is stripped HERE, in the service layer, so the router NEVER
 * sees it. This is a structural guarantee, not a convention to remember at
 * every call site: the `toAdminUserView` helper is the single, named
 * projection function, and the router's type annotations (`AdminUserView`) make
 * a future accidental inclusion of `passwordHash` a TypeScript compile error.
 *
 * ===========================================================================
 * Account creation — temp password, hash storage, welcome email
 * ===========================================================================
 * `POST /admin/users` creates a staff account with a randomly-generated
 * temporary password:
 *   1. Generate: `crypto.randomBytes(16).toString('hex')` — 32 hex chars,
 *      high entropy, easy for an Admin to copy-paste.
 *   2. Hash: `hashPassword(tempPassword)` (argon2id, pinned parameters — see
 *      `auth/password.ts` for the full parameter rationale).
 *   3. Store: only the HASH is persisted. The plaintext is returned ONCE in
 *      the creation response (`{ user, temporaryPassword }`) — never again.
 *      The Admin copies it to send out-of-band, or the welcome email carries it.
 *   4. Email: `mailService.send(...)` dispatches a welcome/invite email
 *      containing the temp password with a "change this immediately" note.
 *      Email failures are logged but do NOT roll back the account creation —
 *      a failed email is recoverable (the Admin has the temp password in the
 *      creation response); an incomplete account creation is not.
 *
 * ===========================================================================
 * Guard rails on PATCH — last-Admin lockout & self-lock prevention
 * ===========================================================================
 * Two guards are applied on every PATCH before the update is committed:
 *
 *   1. LAST-ADMIN LOCKOUT: if the target user is currently an active Admin
 *      AND the patch would deactivate or demote them, the service first
 *      counts active Admins. If the count is exactly 1, it rejects with
 *      `badRequest('Cannot deactivate or demote the last active Admin ...')`.
 *      If > 1, it allows the change — the system remains accessible.
 *      WHY: an unrecoverable state (zero active Admins) requires direct DB
 *      intervention to fix. One cheap count query now, painful recovery never.
 *
 *   2. SELF-LOCK: if `actor.id === target.id` AND the patch would deactivate
 *      or demote the actor, the service rejects with `badRequest('Admins
 *      cannot deactivate or demote their own account via this endpoint')`.
 *      WHY: the classic "why did I just lock myself out" footgun. Structurally
 *      the same concern as last-Admin lockout but caught earlier (before the
 *      count query) and with a more specific error message.
 *
 * Note: deactivating a user does NOT immediately invalidate their existing
 * sessions. `requireAuth`/`requireRole` re-derive the user from the DB on
 * every request (see `middleware/rbac.ts`'s "isActive enforcement" note —
 * this is the mechanism behind ADR-0002's "deactivation takes effect
 * immediately" promise), so the deactivated user's very next protected request
 * will fail with 401. No extra session-invalidation work is needed here.
 *
 * ===========================================================================
 * Audit logging for role changes — Phase 4c precedent (structured pino)
 * ===========================================================================
 * plan.md Phase 4f step 3 raises the `AuditLog` table question and defers the
 * decision. Phase 4c already faced the identical question (CSV export audit
 * — see `registrations.service.ts`'s `exportForEvent` doc-comment) and chose
 * STRUCTURED PINO LOGGING over a schema addition, with the explicitly-
 * documented reasoning:
 *
 *   - Satisfies the literal requirement (architecture.md §7.3.1 "role changes
 *     are Admin-only operations, audit-logged") with zero schema change.
 *   - The logged field set (`event`, `actorId`, `actorEmail`, `targetUserId`,
 *     `fromRole`, `toRole`, `timestamp`) mirrors EXACTLY what a future
 *     `AuditLog` table row would contain — the same fields, the same
 *     structure, just in a log stream rather than a DB row. A future migration
 *     to a dedicated `AuditLog` table is a purely-additive change that does
 *     not require revisiting this service's logic (only the log sink changes).
 *   - Consistent with the established precedent: Phase 4c's `exportForEvent`
 *     audit entry uses the same `logger.info({ event: 'csv_export', ... })`
 *     pattern. A second module using a different audit mechanism — especially
 *     a more complex one — would introduce inconsistency without a concrete,
 *     evaluated reason to diverge.
 *
 * When a PATCH changes a user's `role`, this service logs:
 *   `{ event: 'role_change', actorId, actorEmail, targetUserId, fromRole,
 *      toRole, timestamp }` via the injected `logger` at `info` level.
 */
import { randomBytes } from 'node:crypto';

import type { User } from '@prisma/client';
import type { Logger } from 'pino';

import { badRequest, conflict, notFound } from '../../lib/errors';
import type { PaginatedResult } from '../../lib/pagination';
import { hashPassword } from '../auth/password';
import type { AuthenticatedUser } from '../auth/auth.service';
import type { MailMessage, MailService } from '../auth/mail.service';
import type { UsersRepository, ListUsersFilter } from './users.repository';
import type { CreateUserInput, PatchUserInput, ListUsersQuery } from './users.schemas';
import { TEMP_PASSWORD_BYTES } from './users.constants';

/**
 * The safe, serializable shape returned by every Users module endpoint.
 * ALL fields from `User` EXCEPT `passwordHash` — stripping it here, at the
 * type level, means the router can never accidentally include it in a
 * response (a TypeScript compile error would result if the router tried to
 * read `user.passwordHash` from an `AdminUserView`).
 */
export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: User['role'];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Projects a raw Prisma `User` row into the safe `AdminUserView` shape —
 * the single, named projection function that ensures `passwordHash` is NEVER
 * included in any value that leaves the service layer. */
function toAdminUserView(user: User): AdminUserView {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Whether a PATCH input would deactivate or demote a currently-active Admin
 * — used by BOTH the self-lock and last-Admin-lockout guards. Named once so
 * both checks share the identical, reviewed predicate. */
function wouldDeactivateOrDemote(patch: PatchUserInput): boolean {
  return patch.isActive === false || (patch.role !== undefined && patch.role !== 'ADMIN');
}

export interface UsersServiceOptions {
  repository: UsersRepository;
  mailService: MailService;
  logger: Logger;
}

export interface UsersService {
  /**
   * Paginated list of staff accounts, optionally filtered by `role` and/or
   * `isActive`. Returns `AdminUserView` (never `passwordHash`).
   */
  listUsers(
    filter: Pick<ListUsersQuery, 'role' | 'isActive'>,
    pagination: Pick<ListUsersQuery, 'page' | 'limit'>,
  ): Promise<PaginatedResult<AdminUserView>>;

  /**
   * Single user by id. Returns `AdminUserView` (never `passwordHash`).
   * Throws `notFound()` if the id does not correspond to any user.
   */
  getUserById(id: string): Promise<AdminUserView>;

  /**
   * Creates a staff account with a randomly-generated temporary password.
   * Returns `{ user: AdminUserView, temporaryPassword: string }` — the
   * plaintext temp password is returned ONCE and ONLY ONCE here; never
   * logged, never stored in plain form, never returned again.
   *
   * Throws `conflict('An account with this email already exists')` on a
   * duplicate email.
   *
   * `firstName` and `surname` (from the schema) are used for the welcome
   * email greeting if provided, then discarded — they are NOT stored in the
   * DB (the `User` schema has a single `name` field; the display name stored
   * is derived from `firstName`+`surname` if provided, else from the email
   * local part).
   */
  createUser(
    input: CreateUserInput,
  ): Promise<{ user: AdminUserView; temporaryPassword: string }>;

  /**
   * Partially updates a user's `role`, `email`, or `isActive`. Applies the
   * last-Admin lockout and self-lock guards before committing. Returns the
   * updated `AdminUserView` (never `passwordHash`).
   *
   * Throws `notFound()` if the target id does not correspond to any user.
   * Throws `badRequest(...)` if either guard rejects the change.
   * Throws `conflict(...)` if the new `email` is already taken by another
   * account.
   *
   * Logs a structured `{ event: 'role_change', ... }` entry when `role`
   * changes — see this file's header "Audit logging" section for rationale.
   */
  patchUser(
    actor: AuthenticatedUser,
    targetId: string,
    patch: PatchUserInput,
  ): Promise<AdminUserView>;
}

export function createUsersService({
  repository,
  mailService,
  logger,
}: UsersServiceOptions): UsersService {
  return {
    async listUsers(filter, pagination) {
      const listFilter: ListUsersFilter = {};
      if (filter.role !== undefined) {
        listFilter.role = filter.role;
      }
      if (filter.isActive !== undefined) {
        listFilter.isActive = filter.isActive;
      }

      const result = await repository.list(listFilter, {
        page: pagination.page,
        limit: pagination.limit,
      });

      return {
        ...result,
        items: result.items.map(toAdminUserView),
      };
    },

    async getUserById(id) {
      const user = await repository.findById(id);
      if (!user) {
        throw notFound('User not found');
      }
      return toAdminUserView(user);
    },

    async createUser(input) {
      // Duplicate-email check — reject before any other work.
      const existing = await repository.findByEmail(input.email);
      if (existing) {
        throw conflict('An account with this email already exists');
      }

      // Generate and hash the temporary password — see file-header "Account
      // creation" note for the "16 bytes -> 32 hex chars" rationale.
      const tempPassword = randomBytes(TEMP_PASSWORD_BYTES).toString('hex');
      const passwordHash = await hashPassword(tempPassword);

      // Derive the display `name` from `firstName`/`surname` if provided,
      // otherwise use the email local part (everything before '@') — a
      // reasonable, non-empty default that avoids a blank `name` field.
      // `firstName`/`surname` are NOT stored; only this derived `name` is.
      let displayName: string;
      if (input.firstName || input.surname) {
        displayName = [input.firstName, input.surname].filter(Boolean).join(' ');
      } else {
        displayName = input.email.split('@')[0] ?? input.email;
      }

      const newUser = await repository.create({
        name: displayName,
        email: input.email,
        passwordHash,
        role: input.role,
      });

      // Welcome email — best-effort: a failure here does NOT roll back the
      // account creation (see file-header "Account creation" note).
      const greetingName = input.firstName ?? displayName;
      const welcomeMessage: MailMessage = {
        to: input.email,
        subject: 'Welcome to Rejuvenate — your staff account is ready',
        text:
          `Hello ${greetingName},\n\n` +
          'A staff account has been created for you on the Rejuvenate platform.\n\n' +
          'Your temporary password is:\n\n' +
          `  ${tempPassword}\n\n` +
          'Please log in and change this password immediately — it is a one-time ' +
          'credential that should not be kept or shared.\n\n' +
          `Your assigned role is: ${input.role}\n\n` +
          'If you did not expect this email, please contact your administrator.',
      };

      try {
        await mailService.send(welcomeMessage);
      } catch (err) {
        // Recoverable — the Admin has the temp password in the API response.
        // Log and continue; do not let a failed email propagate as a 500 or
        // roll back the successfully-created account.
        logger.warn(
          { err: err instanceof Error ? { name: err.name, message: err.message } : String(err), targetEmail: input.email },
          'UsersService.createUser: welcome email failed to send — account was created successfully; Admin should forward the temporary password manually',
        );
      }

      return {
        user: toAdminUserView(newUser),
        temporaryPassword: tempPassword,
      };
    },

    async patchUser(actor, targetId, patch) {
      const target = await repository.findById(targetId);
      if (!target) {
        throw notFound('User not found');
      }

      // -----------------------------------------------------------------------
      // GUARD 1: Self-lock prevention
      // -----------------------------------------------------------------------
      // If the actor is patching THEIR OWN account and the patch would
      // deactivate or demote them, reject immediately — before the last-Admin
      // count query, since the self-lock check is cheaper (no DB round trip)
      // and catches the "I just locked myself out" footgun regardless of how
      // many other Admins exist.
      if (actor.id === targetId && target.role === 'ADMIN' && wouldDeactivateOrDemote(patch)) {
        throw badRequest(
          'Admins cannot deactivate or demote their own account via this endpoint',
        );
      }

      // -----------------------------------------------------------------------
      // GUARD 2: Last-Admin lockout prevention
      // -----------------------------------------------------------------------
      // If the target is currently an active Admin AND the patch would
      // deactivate or demote them, verify at least one OTHER active Admin
      // exists before allowing the change.
      if (target.role === 'ADMIN' && target.isActive && wouldDeactivateOrDemote(patch)) {
        const activeAdminCount = await repository.countActiveAdmins();
        if (activeAdminCount <= 1) {
          throw badRequest(
            'Cannot deactivate or demote the last active Admin — the system would become inaccessible',
          );
        }
      }

      // -----------------------------------------------------------------------
      // Email uniqueness check (only if email is being changed)
      // -----------------------------------------------------------------------
      if (patch.email !== undefined && patch.email !== target.email) {
        const emailTaken = await repository.findByEmail(patch.email);
        if (emailTaken) {
          throw conflict('An account with this email already exists');
        }
      }

      // -----------------------------------------------------------------------
      // Perform the update
      // -----------------------------------------------------------------------
      const updated = await repository.update(targetId, {
        role: patch.role,
        email: patch.email,
        isActive: patch.isActive,
      });

      // -----------------------------------------------------------------------
      // Audit log for role changes — see file-header "Audit logging" section.
      // This is the SAME pattern Phase 4c's registrations.service.ts uses for
      // CSV-export audit entries (the "structured pino logging vs. AuditLog
      // table" decision record is documented there and cross-referenced here).
      // -----------------------------------------------------------------------
      if (patch.role !== undefined && patch.role !== target.role) {
        logger.info(
          {
            event: 'role_change',
            actorId: actor.id,
            actorEmail: actor.email,
            targetUserId: targetId,
            fromRole: target.role,
            toRole: patch.role,
            timestamp: new Date().toISOString(),
          },
          'User role changed by Admin',
        );
      }

      return toAdminUserView(updated);
    },
  };
}
