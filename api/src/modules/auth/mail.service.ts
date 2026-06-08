/**
 * Transactional-email abstraction (plan.md Phase 3 step 4 / open question
 * "Confirm transactional email provider").
 *
 * architecture.md §14 flags the provider choice as an open question requiring
 * stakeholder input (data-residency / POPIA-aware sending reputation — a
 * South-African-friendly regional provider is recommended over a generic
 * US-based SaaS). That choice does NOT block building the password-reset
 * *mechanism* (token generation, expiry, single-use — see `auth.service.ts`)
 * — only the actual sending. This file is the seam: a small interface plus a
 * console/log-based dev implementation, exactly as the plan recommends, so
 * swapping in a real provider later (SMTP relay, regional transactional-email
 * API, etc.) is a one-file change behind an unchanged interface.
 *
 * ---------------------------------------------------------------------------
 * Why an interface + factory, not a concrete class wired directly into
 * `AuthService`
 * ---------------------------------------------------------------------------
 * `AuthService` depends on `MailService` (the interface) and is constructed
 * with one via dependency injection (see `auth.service.ts`'s factory). This:
 *   - lets tests substitute a trivial recording stub instead of asserting on
 *     console output (fast, no log-scraping, asserts on structured data); and
 *   - keeps the swap-in-a-real-provider change confined to ONE new file (e.g.
 *     `smtp-mail.service.ts` implementing the same `MailService` interface)
 *     plus one line in whatever wires `AuthService` up for the real app —
 *     `auth.service.ts` and its tests need not change at all.
 *
 * ---------------------------------------------------------------------------
 * `ConsoleMailService` — the dev/test implementation
 * ---------------------------------------------------------------------------
 * Logs the would-be email via the structured `pino` logger (never raw
 * `console.log` — see app.ts's redaction posture) at `info` level, with the
 * recipient and a clearly-labelled subject/body. This is sufficient for local
 * development (an operator/developer can read the reset link straight out of
 * the terminal) and for the test suite (nothing actually needs to leave the
 * process). It is NOT swapped in based on `NODE_ENV` automatically inside this
 * file — the *caller* decides which implementation to construct (today: always
 * this one, since no real provider is wired yet; the moment one is, that
 * decision moves to the composition root, not into a conditional buried here).
 *
 * `env.SMTP_*` already exist in `config/env.ts` (added ahead of this module
 * specifically so a future SMTP-backed implementation has zero env-schema work
 * left to do) but are deliberately UNUSED by this file — wiring them up without
 * a chosen, tested provider would be exactly the kind of speculative
 * infrastructure the project's YAGNI guidance warns against. They sit there,
 * validated and ready, until the provider question is answered.
 */
import type { Logger } from 'pino';

/** A single transactional email to send. Intentionally minimal — exactly the
 * shape `AuthService`'s password-reset flow needs today. Extend (don't
 * restructure) when RSVP-confirmation emails (Phase 6) need more. */
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. No HTML-templating layer exists yet (YAGNI — the only
   * caller today is a short reset-link notice); add one when a second,
   * richer use case (e.g. RSVP confirmations) actually needs it. */
  text: string;
}

/** The seam `AuthService` (and, later, Registration/RSVP flows) depend on.
 * Implementations must resolve once the message has been hand off to the
 * sending mechanism — they do not need to guarantee delivery, only that the
 * attempt was made (mirrors how most transactional-email APIs/SMTP relays
 * behave: "accepted for delivery" is the synchronous contract; bounces/
 * failures are handled out-of-band). */
export interface MailService {
  send(message: MailMessage): Promise<void>;
}

/**
 * Dev/test `MailService` — logs the message via the structured request/app
 * logger instead of sending it anywhere. This is the ONLY implementation that
 * exists today (see file-header "open question" note); it is intentionally
 * named for what it does (`ConsoleMailService`), not for an environment
 * (`DevMailService`) — it is exactly as correct in `test` as in `development`,
 * and using an environment-shaped name would invite someone to assume a
 * different implementation magically appears in `production` (it does not,
 * yet — that is the explicitly-flagged open question).
 */
export class ConsoleMailService implements MailService {
  constructor(private readonly logger: Logger) {}

  async send(message: MailMessage): Promise<void> {
    // `await` nothing — logging is synchronous — but keep the method `async`
    // so this implementation satisfies `MailService` identically to a real
    // network-bound one (callers always `await mailService.send(...)`
    // regardless of which implementation is wired in).
    this.logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      '[ConsoleMailService] Would send email (no real provider configured — see mail.service.ts file header)',
    );
  }
}
