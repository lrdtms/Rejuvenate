/**
 * Shared server-side rich-text sanitizer (architecture.md §12.1.9 / §9.5,
 * plan.md Phase 4a step 2).
 *
 * ===========================================================================
 * THIS IS THE SINGLE SOURCE OF TRUTH FOR "WHAT HTML IS ALLOWED ANYWHERE ON
 * THIS SITE" — Phase 4d (CMS module), when it's built, MUST import
 * `sanitizeRichText`/`RICH_TEXT_ALLOW_LIST` from here rather than inventing a
 * parallel `sanitize-html` config.
 * ===========================================================================
 *
 * Why this matters enough to shout about in the header: architecture.md §9.5
 * describes TWO independent rich-text surfaces — blog post bodies (a
 * heavier, TipTap-class editor; headings/lists/links/images, per plan.md
 * Phase 8 step 1) and CMS slot values (deliberately tiny — "bold, italic,
 * line breaks only," §9.5's "no formatting surprises" WYSIWYG mandate). It
 * would be easy — and WRONG — for whoever builds CMS to write a second,
 * independent `sanitize-html` config "for CMS" that quietly drifts from this
 * one (different tag casing, a forgotten `transformTags` rule, a slightly
 * different attribute allow-list) — now there are TWO things to keep in sync
 * every time the security team revisits "what HTML is safe to store," and a
 * gap between them is exactly the kind of thing that becomes an XSS finding
 * eighteen months later. One *config*, two call sites with DIFFERENT
 * allow-lists for DIFFERENT content types — see `RICH_TEXT_ALLOW_LIST` vs
 * `CMS_RICH_TEXT_ALLOW_LIST` below — sharing the SAME library, the SAME
 * baseline hardening options (`allowedSchemes`, `disallowedTagsMode`, no
 * `style`/`class`/`on*` attributes anywhere), and the SAME exported factory
 * shape (`buildSanitizer(allowList)`), so the only thing that can vary
 * between Blog and CMS is the deliberately-named, deliberately-reviewed list
 * of permitted tags — never the underlying security posture.
 *
 * ---------------------------------------------------------------------------
 * Why an allow-list (not a deny-list), and why server-side (not client-side)
 * ---------------------------------------------------------------------------
 * architecture.md §12.1.9 names the requirement explicitly: "sanitize blog/
 * CMS rich-text server-side against a strict allow-list before storage."
 * An allow-list ("only these tags/attributes ever survive") is the only
 * sound posture for user-/admin-supplied HTML — a deny-list ("strip these
 * known-bad things") is a losing game of whack-a-mole against an effectively
 * unbounded space of XSS vectors (`<svg onload=...>`, `javascript:` URLs,
 * `data:` URIs, obscure tag/attribute combinations browsers still parse).
 * Sanitizing server-side, on every create/update, BEFORE storage means a
 * stored row is safe to render anywhere, by anyone, forever — independent of
 * which client wrote it or whether that client's own sanitization can be
 * trusted (it can't: "never trust client-sanitized HTML" is architecture.md
 * §9.5's explicit instruction, and a non-browser client — curl, a future
 * mobile app, a compromised admin session replaying captured requests — has
 * no client-side sanitizer running at all).
 *
 * ---------------------------------------------------------------------------
 * `RICH_TEXT_ALLOW_LIST` — the Blog post-body allow-list
 * ---------------------------------------------------------------------------
 * Scoped to exactly what plan.md Phase 8 step 1 says the PRD asks the
 * blog-post editor to produce — "rich text + embedded images: headings,
 * bold/italic, lists, links, images" — and Phase 8 step 1's own warning to
 * "resist the urge to enable every plugin TipTap ships with": the sanitizer's
 * allow-list IS the hard ceiling on what the editor's toolbar may responsibly
 * expose, because anything the editor can produce that ISN'T here gets
 * silently stripped on save (a confusing "my formatting disappeared" support
 * issue per that step's note). Coordinate any toolbar change with this list —
 * they must agree by construction, not by accident.
 *
 *   - Headings: `h2`-`h4` only (not `h1` — a post body should never contain
 *     a competing top-level heading; the page chrome owns the `<h1>`, per
 *     Phase 5's "single `<h1>` per page" accessibility convention).
 *   - Emphasis & structure: `p`, `br`, `strong`, `em`, `ul`/`ol`/`li`,
 *     `blockquote`.
 *   - Links: `a` with `href` constrained to `http(s)`/`mailto` schemes only
 *     (see `allowedSchemes` — blocks `javascript:`/`data:`/`vbscript:` link
 *     XSS vectors at the attribute-value level, not just the tag level) and
 *     `rel="noopener noreferrer"` + `target="_blank"` forced via
 *     `transformTags` (an admin-authored link to an external site shouldn't
 *     be able to `window.opener`-hijack the Rejuvenate tab it was opened
 *     from — defense-in-depth that costs nothing and protects visitors from
 *     a mistake, not just malice).
 *   - Images: `img` with `src`/`alt` only — `alt` is REQUIRED content for
 *     this app (plan.md Phase 6 step 2: "lists any attached MediaAsset
 *     images with their `altText`" — accessibility AND POPIA-adjacent EXIF-
 *     stripping both live in the Media module, not here; this sanitizer's
 *     job is only to ensure the `<img>` tag itself can't smuggle an
 *     `onerror=`/`onload=` handler or a `javascript:`/`data:` `src`).
 *
 * ---------------------------------------------------------------------------
 * `CMS_RICH_TEXT_ALLOW_LIST` — the (much smaller) CMS slot allow-list
 * ---------------------------------------------------------------------------
 * Deliberately tiny, matching architecture.md §9.5's literal description of
 * the CMS "richText" format ceiling: "bold, italic, line breaks only — no
 * headings, tables, embeds, or arbitrary HTML." No links, no images, no
 * lists, no headings — CMS slots are small structured text regions (cards,
 * contact details), and §9.5 explicitly rules out a heavier WYSIWYG
 * experience there as the CORRECT tradeoff (over-engineering for a contact
 * card otherwise). Exported here, ready for Phase 4d to import unchanged.
 *
 * ---------------------------------------------------------------------------
 * Hardening that applies to BOTH allow-lists, unconditionally
 * ---------------------------------------------------------------------------
 *   - `allowedSchemes: ['http', 'https', 'mailto']` — no `javascript:`/
 *     `data:`/`vbscript:` etc. anywhere a URL-shaped attribute appears.
 *   - `allowedSchemesByTag` left at the library default (which already keys
 *     off `allowedSchemes` for `href`/`src`-bearing tags) — not widened.
 *   - `allowProtocolRelative: false` — a `//evil.example` URL can't silently
 *     inherit the page's protocol to reach an attacker-controlled origin.
 *   - `disallowedTagsMode: 'discard'` (the library default, named explicitly
 *     so a future change to `'escape'` is a deliberate, reviewed decision —
 *     `discard` drops disallowed tags AND their content for genuinely
 *     dangerous elements like `<script>`/`<style>`, which is the correct
 *     posture for admin-authored content; `escape` would be appropriate for
 *     "show the user what they typed back at them," which is not this app's
 *     use case).
 *   - No `style`, `class`, or `on*` attributes are EVER allowed, on ANY tag —
 *     `allowedAttributes` is an explicit per-tag allow-list with nothing
 *     resembling a wildcard; inline styles/classes would let admin-authored
 *     content fight the site's branding/layout (which architecture.md §10.3
 *     and §6.5 both insist stays "code-controlled"), and `on*` handlers are
 *     the most direct XSS vector `sanitize-html` exists to close.
 */
import sanitizeHtml from 'sanitize-html';

/** URL schemes permitted in `href`/`src` attributes, everywhere. Blocks
 * `javascript:`, `data:`, `vbscript:`, and any other script-execution-capable
 * scheme at the attribute-value level — the allow-list applies even to tags
 * that are themselves permitted (an allowed `<a href="javascript:...">` is
 * still rejected down to a plain, schema-less `href`-less anchor). */
const ALLOWED_URL_SCHEMES = ['http', 'https', 'mailto'];

/** Baseline options shared by every allow-list this module exports — the
 * "same security posture, different permitted vocabulary" guarantee named in
 * the file header. Spread into each `sanitizeHtml.IOptions` below; never
 * overridden per-allow-list (if a future allow-list NEEDS different baseline
 * hardening, that's a sign it shouldn't share this factory — flag it for
 * review rather than parameterizing this baseline into meaninglessness). */
const BASE_OPTIONS: sanitizeHtml.IOptions = {
  allowedSchemes: ALLOWED_URL_SCHEMES,
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Belt-and-braces: even though every per-tag `allowedAttributes` entry
  // below is an explicit, reviewed list, `allowedAttributes: false` would
  // mean "any attribute is fine" if a future edit accidentally removed a
  // tag's entry — naming `allowedAttributes` per-tag (never omitting a
  // permitted tag's entry) is the only mode that fails CLOSED.
};

/**
 * The Blog post-body allow-list (plan.md Phase 8 step 1's editor scope —
 * see file header for the full per-tag rationale). Exported (not just used
 * internally) so the editor team can treat this list as the literal,
 * authoritative ceiling on toolbar capability — "if it's not in this array,
 * the editor must not offer it," not a separate document to keep in sync.
 */
export const RICH_TEXT_ALLOW_LIST: sanitizeHtml.IOptions = {
  ...BASE_OPTIONS,
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'blockquote',
    'a',
    'img',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
    img: ['src', 'alt', 'data-size'],
  },
  // Forces every surviving `<a>` to carry safe `rel`/`target` regardless of
  // what the editor produced — closes the `window.opener` reverse-tabnabbing
  // vector named in the file header without relying on the editor to get it
  // right (and without rejecting links that omit it, which would be an
  // unhelpfully strict failure mode for ordinary admin-authored content).
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true),
  },
};

/**
 * The CMS slot `richText` allow-list (architecture.md §9.5's literal "bold,
 * italic, line breaks only" ceiling — see file header for why it is
 * deliberately this much smaller than the Blog list, and why that's correct
 * rather than an oversight). Phase 4d: import this directly; do not redefine
 * a parallel "CMS allow-list" elsewhere.
 */
export const CMS_RICH_TEXT_ALLOW_LIST: sanitizeHtml.IOptions = {
  ...BASE_OPTIONS,
  allowedTags: ['p', 'br', 'strong', 'em'],
  allowedAttributes: {},
};

/**
 * Generic factory: returns a sanitizer function bound to the given
 * `sanitize-html` options. Both `sanitizeBlogPostBody` and (eventually)
 * the CMS module's `sanitizeCmsRichText` are thin, named call sites over
 * this — keeping "which allow-list does THIS content type use" a one-line,
 * greppable fact rather than a `sanitizeHtml(value, SOME_OPTIONS_VARIABLE)`
 * call that requires chasing an import to understand.
 */
function buildSanitizer(options: sanitizeHtml.IOptions): (html: string) => string {
  return (html: string): string => sanitizeHtml(html, options);
}

/**
 * Sanitizes a Blog post body against `RICH_TEXT_ALLOW_LIST`. Called by
 * `BlogService` on EVERY create/update of `body` (architecture.md §12.1.9 —
 * "on every create/update," not just at initial authoring; an edited post's
 * new body is exactly as untrusted as its first version) — see
 * `blog.service.ts` for the call sites and the "sanitize before persisting,
 * never persist-then-sanitize" ordering rationale.
 */
export const sanitizeBlogPostBody = buildSanitizer(RICH_TEXT_ALLOW_LIST);

/**
 * Sanitizes a CMS `richText`-format slot value against
 * `CMS_RICH_TEXT_ALLOW_LIST`. Defined here (not in the CMS module) so Phase
 * 4d's `CmsService.updateSlot` can import it directly — see file header.
 * `plainText`-format slots do NOT go through this function: per architecture
 * .md §9.5, plain-text values are stored as-is and ESCAPED ON RENDER (a
 * different control, applied at a different layer — the renderer, not the
 * writer; sanitizing plain text on write would be redundant work that also
 * risks mangling legitimate plain-text content like `"Tom & Jerry's Café"`).
 */
export const sanitizeCmsRichText = buildSanitizer(CMS_RICH_TEXT_ALLOW_LIST);
