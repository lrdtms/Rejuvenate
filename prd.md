# Rejuvenate — Product Requirements Document

> Last updated: 2026-06-07 · Status: Draft

## 1. Vision
Keep Rejuvenate members "plugged in" — informed and connected to their community. Rejuvenate's website will evolve from a static informational site into a living hub where members can catch up on past events through blog-style recaps (text + images) and discover, register for, and be tracked at upcoming events. The platform empowers Rejuvenate's own staff and volunteer leaders (across Cape Town, Durban, and beyond) to keep content fresh — without ever needing a developer to make routine updates.

## 2. Problem Statement
Today, Rejuvenate runs a static, developer-maintained HTML/CSS/JS website (Home, About, Cape Town, Durban, Contact). It cannot:
- Communicate with members who missed an event ("what did we do at that event?")
- Promote upcoming events in a structured, trackable way
- Let Rejuvenate's own staff/leaders update even basic content (About info, location/contact details) without a developer editing code and redeploying

This creates two pains:
1. **Members feel disconnected** — they have no easy way to see what happened at past events or what's coming up.
2. **Staff are bottlenecked by developers** — every content change (a new event, a blog recap, an updated contact number) requires a code change, slowing everything down and creating an unsustainable dependency.

## 3. Target Users
- **Members / site visitors** — the general public and church/community members across Cape Town and Durban branches. Likely a mix of tech sophistication; the public-facing site must remain simple and accessible.
- **Admins** — full-access staff (presumably senior leadership/IT-adjacent staff) who manage everything: blog, events, registrations, CMS content, and (presumably) user accounts/roles.
- **Bloggers** — Cape Town/Durban leaders or staff tasked with writing event recap posts (text + images). Not necessarily technical.
- **Event Managers** — staff responsible for creating and running events, and tracking who has registered/RSVP'd.

Scale: Not specified numerically (TBD — no member counts or expected concurrent-user volumes given). The system should comfortably support a small-to-mid-size community organization with two physical branches.

## 4. Goals & Success Metrics
**Primary success criterion (verbatim from stakeholder):** *"Admin can update content with no dev."*

In concrete terms, v1 is successful when:
- Admins, Bloggers, and Event Managers can independently create/edit/publish blog posts, create/manage events, view event registrations and headcounts, and edit the defined CMS content areas (About cards, location/contact cards, Contact page details) — **without filing a request to a developer or touching code.**
- The site continues to look and behave consistently with the existing branding (logo, colors, banners, layout, navigation), which remains developer-managed.

No numeric KPIs (e.g., member growth, event attendance targets, page-view goals) were specified — operational self-sufficiency for content management is the defining measure of success. No fixed launch deadline was given (open-ended timeline).

## 5. User Journeys

### 5.1 Member reads an event recap (Blog)
1. Member visits the Rejuvenate site (Home or a branch page).
2. Member navigates to the Blog section / sees a recap post about a recent event.
3. Member reads the recap (text + photos) and gets a feel for what happened, even though they weren't there.
4. (Optional) Member notices an upcoming event mentioned/linked from the post and clicks through to view it.

### 5.2 Member discovers and registers for an upcoming event
1. Member browses to the Events section (or sees an announcement on Home/branch page).
2. Member opens an event's detail page (date, location, description, branch).
3. Member fills out the RSVP/registration form: **Name, Surname, Age (exact), Email, Phone number.**
4. Member submits; receives confirmation that they're registered.
5. Event Manager/Admin later reviews the attendee list and headcount for planning purposes (e.g., catering, seating, materials).

### 5.3 Staff member publishes a blog recap (Blogger/Admin)
1. Blogger or Admin logs into the admin backend with their credentials.
2. They create a new blog post: add a title, body text, and upload images from the event.
3. They preview/publish the post; it becomes visible on the public Blog section.
4. (Admin only, additionally) Admin can edit or unpublish any post, including those by other Bloggers.

### 5.4 Staff member creates an event and tracks registrations (Event Manager/Admin)
1. Event Manager or Admin logs in and creates a new event: title, description, date/time, location/branch, capacity (optional), and (placeholder field for future) paid/free status.
2. Event is published and appears on the public Events section with a registration form.
3. As members register, the Event Manager/Admin views a running attendee list and headcount for that event.
4. Event Manager/Admin uses this list to plan logistics (numbers, names, contact info if follow-up is needed).

### 5.5 Admin edits CMS content (e.g., updates a Durban contact card)
1. Admin logs into the admin backend.
2. Admin navigates to the CMS content area for the Durban location/contact card.
3. Admin edits the content via a text-box editor where what they type/see in the box matches exactly how it will render live on the public site (WYSIWYG-like fidelity — no surprises after publishing).
4. Admin saves; the live Contact/Durban page reflects the change immediately, with no developer involvement.

## 6. Functional Requirements (MVP Scope)

### 6.1 Public-Facing Site
- Retains existing pages and structure: Home, About, Cape Town, Durban, Contact (plus new Blog and Events sections).
- New **Blog** section: lists published posts; individual post pages display title, author, body text, and images.
- New **Events** section: lists upcoming (and possibly past) events; individual event pages display details and an RSVP/registration form.

### 6.2 Blog (Multi-author)
- Authoring roles: **Admin** and **Blogger**.
- Posts support rich text/body content and embedded/attached images.
- Posts have an author, title, body, images, published/draft status, and timestamps.
- Primary use case: recapping past events for members who couldn't attend.
- Admins can manage (edit/unpublish/delete) any post; Bloggers manage their own posts (exact cross-author edit permissions for Bloggers: TBD — default assumption is Bloggers manage only their own posts unless stated otherwise).

### 6.3 Events & Registration (Free-only in v1)
- Authoring roles: **Admin** and **Event Manager**.
- Event fields: title, description, date/time, location/branch (Cape Town/Durban/other), images (optional), capacity (optional).
- **All v1 events are free.** No payment processing, checkout, or ticketing is included.
- Public registration/RSVP form collects exactly: **Name, Surname, Age (exact value, not a range), Email, Phone number.**
- Admins and Event Managers can view, per event: the full attendee list and a live headcount.
- The previously-present Quicket integration is a **placeholder that was never used for a real event** and is not part of the v1 scope (it can be removed or left dormant — implementation team's call).

### 6.4 Admin Backend & Role-Based Access Control (RBAC)
Three roles, each requiring authenticated login:
- **Admin** — full access: manage blog posts (all authors'), manage events and view all registrations, edit all defined CMS content areas, and (presumed) manage user accounts and role assignments.
- **Blogger** — can create, edit, and publish blog posts (own posts; cross-author permissions TBD).
- **Event Manager** — can create and manage events, and view attendee registrations/headcounts. No blog or CMS access.
- Authentication is required for all three roles; public visitors require no login.

### 6.5 CMS — Editable Site Content (scoped, not "everything")
In-scope editable content areas for v1:
- **About page cards**
- **Location/local contact cards** for both **Cape Town and Durban**
- **Contact page details**

Editing UX requirement: content is edited via **text-box based editors where the admin's input mirrors exactly how the text will render live on the site** (WYSIWYG-like fidelity — what you type is what members see, with no formatting surprises after publishing).

Explicitly **out of scope** for CMS editing in v1: page layout, navigation structure, and branding elements (logo, color scheme, banner images) — these remain developer/code-controlled.

## 7. Out of Scope (v1)
- **Payment processing / paid events / ticketing** — v1 supports free events only. (See Section 14 — this is a documented future consideration, and the data model should not architecturally preclude adding it later.)
- Quicket or any other payment-gateway integration (previous Quicket placeholder was never used and is not being carried forward functionally).
- CMS editing of page layout, navigation/menu structure, branding, logos, color schemes, or banner images — these remain code-controlled.
- Member accounts / member login / member profiles (registration is anonymous/one-off via a form — no persistent member account system implied).
- Numeric growth/attendance KPI tracking or analytics dashboards beyond the basic attendee headcount per event.
- Any mobile app — this is a website only.

## 8. Technical Architecture
- **Stack**: React (frontend), Node.js + Express (backend/API), PostgreSQL (database), Prisma (ORM).
- **Platform / Deployment**: Self-managed Linode VPS (the organization manages its own server/hosting rather than using a managed PaaS).
- **Key Libraries / Services**: TBD at implementation time (e.g., authentication library/strategy, image upload/storage approach, rich-text/WYSIWYG editor component for CMS and blog authoring).
- **Rationale** (as previously communicated to stakeholder):
  - A unified JavaScript/TypeScript stack (React + Node/Express) simplifies development and maintenance with one core language across frontend and backend.
  - A relational data model (PostgreSQL) suits the interconnected nature of blog posts, events, registrations, and user roles.
  - Prisma eases schema migrations and future schema evolution — notably, it will make it straightforward to extend the Event model later (e.g., adding paid-ticketing fields) without a painful re-architecture.
  - This stack is a production-proven combination with no licensing costs, fitting a self-managed VPS deployment model.

## 9. Data Model
High-level entities and relationships (exact field lists/migrations to be finalized during implementation):

- **User**
  - id, name, email, password/credential reference, role (`Admin` | `Blogger` | `EventManager`), timestamps
  - One user has exactly one role (per the 3-tier RBAC model described); Admins can presumably manage other users' roles.

- **BlogPost**
  - id, title, body (rich text), images (one-to-many or array reference), author (→ User), status (`draft`/`published`), publishedAt, timestamps

- **Event**
  - id, title, description, date/time, location/branch (Cape Town | Durban | other), images (optional), capacity (optional), createdBy (→ User), timestamps
  - **Future-proofing fields (recommended, not required for v1 functionality):** `isPaid` (boolean, default `false`) and/or `price` (nullable) — included in the schema design now so that v1 ships as free-only, but the model does not need to be re-architected when paid ticketing is introduced later.

- **Registration / RSVP**
  - id, event (→ Event), name, surname, age (integer/exact value), email, phone number, registeredAt
  - No link to a User/member account — registrations are anonymous, one-off submissions tied only to an event.

- **CMSContent** (or similarly-named editable-content entity)
  - id, content area/key (e.g., `about.card.1`, `contact.capeTownCard`, `contact.durbanCard`, `contact.pageDetails`), text/rich-text value, lastEditedBy (→ User), timestamps
  - Structure should map cleanly to the specific editable areas named in Section 6.5 — not a generic "edit anything" system.

Relationships: A `User` (Admin/Blogger) authors many `BlogPost`s; a `User` (Admin/EventManager) creates many `Event`s; an `Event` has many `Registration`s; `CMSContent` entries are edited by `User`s (Admins) and rendered into specific public-page slots.

## 10. Integrations
- **None required for v1.** No payment gateway, no third-party event/ticketing platform (Quicket placeholder is dormant/unused and not being integrated functionally), no external auth providers specified.
- **Authentication**: to be implemented natively (e.g., email/password with sessions or JWTs) — specific library/approach is TBD at implementation time.
- **Image hosting/storage**: approach TBD — could be local filesystem on the Linode VPS, or an object-storage service; to be decided during implementation planning.
- **Future integration candidate**: a payment gateway (e.g., Quicket or an alternative) if/when paid events are introduced (see Section 14).

## 11. Non-Functional Requirements
- **Performance**: No specific numeric targets given (TBD). The site should remain responsive for a small-to-mid-size community organization's traffic; reasonable page-load expectations for a content-driven site (e.g., sub-2-second loads on typical connections) should guide implementation, but are not hard-confirmed requirements.
- **Security**: Authenticated, role-gated access to the admin backend is required for all three roles (Admin, Blogger, Event Manager). Passwords/credentials must be stored securely (hashed). Registration data (containing personal info: name, age, email, phone) must be handled and stored responsibly.
- **Privacy/Compliance**: Registration forms collect personal information (including age) from the public. No specific compliance regime (e.g., POPIA, GDPR) was named by the stakeholder, but given the South African context (Cape Town/Durban), **POPIA considerations should be flagged as a TBD/risk** for the implementation team to confirm with the organization.
- **Accessibility**: No specific standard (e.g., WCAG level) was specified — TBD. Given the public, community-facing nature of the site, baseline accessibility good practice is recommended.
- **Browser/Device support**: Not specified — assume modern desktop and mobile browsers, consistent with the existing site's responsive design (note: a recent commit fixed a "Cape Town mobile banner top gap," indicating mobile responsiveness already matters to this project).
- **Reliability/Uptime**: No SLA specified — TBD. Self-managed VPS hosting means the organization (or its contracted developer) is responsible for uptime, backups, and patching.

## 12. Constraints
- **Timeline**: Open-ended — no fixed deadline or triggering event specified ("whenever it's ready").
- **Budget**: Not specified (TBD). Tech choices were explicitly made to avoid licensing costs (open-source stack, self-managed VPS).
- **Team size/composition**: Not specified (TBD) — presumed to be a small team or a single developer/contractor (Thomas) building for a community organization.
- **Existing systems to respect**: The current static site's branding, look-and-feel, navigation, and page structure (Home, About, Cape Town, Durban, Contact) should be preserved/extended rather than replaced — these remain developer/code-controlled per the CMS scope decision (Section 6.5).
- **Technical debt**: The dormant Quicket placeholder integration exists in the current codebase but was never used; the implementation team should decide whether to remove it or leave it inert.

## 13. Risks & Open Questions
- **TBD — Blogger cross-author permissions**: Can Bloggers edit/manage only their own posts, or also each other's? (Default assumption: own posts only; Admin can manage all.)
- **TBD — User/role management**: Confirm that Admins are responsible for creating accounts and assigning roles to Bloggers/Event Managers (presumed but not explicitly stated).
- **TBD — Authentication approach**: Specific library/strategy (sessions vs. JWT, password reset flow, etc.) not yet decided.
- **TBD — Image storage approach**: Local filesystem on the Linode VPS vs. object storage — to be decided during implementation planning.
- **Risk — POPIA / personal data handling**: The registration form collects personal data including exact age, email, and phone number from the general public. The organization should confirm its obligations under South Africa's POPIA (or equivalent) for storing and processing this data, including retention policy (how long registration data is kept) and whether explicit consent language is needed on the form.
- **TBD — Event capacity/waitlisting**: Should events have a maximum capacity with waitlisting if full? (Mentioned only as "optional" in the data model — not confirmed as a v1 requirement.)
- **TBD — Numeric scale targets**: No member counts, expected event volumes, or traffic estimates were provided; infrastructure sizing on the Linode VPS should be revisited once real usage data is available.
- **Risk — Self-managed hosting overhead**: A self-managed Linode VPS requires ongoing maintenance (OS patching, backups, SSL renewal, monitoring) — confirm who owns this responsibility long-term.
- **Open — Quicket placeholder disposition**: Remove entirely or leave dormant in the codebase for potential future reactivation?

## 14. Future Considerations (v2+)
- **Paid events / ticketing**: The stakeholder explicitly noted that events "might be paid for in future, so we might need the option for it to either be paid or unpaid." This is **not in v1 scope**, but the v1 data model is recommended to include forward-compatible placeholders (e.g., an `isPaid` boolean and/or nullable `price` field on the `Event` entity, as noted in Section 9) so that a future payment integration (potentially Quicket, given its prior placeholder presence, or an alternative gateway) can be layered on without re-architecting the core Event schema.
- **Member accounts**: Possible future introduction of persistent member profiles/login (e.g., to track a member's registration history across multiple events, rather than one-off anonymous form submissions).
- **Expanded CMS scope**: Potentially extending editable-content control to more of the site (e.g., navigation labels, additional page sections) if Admins find the v1 scope too limiting.
- **Analytics/reporting**: Possible future dashboards beyond basic per-event headcounts (e.g., trends in attendance over time, blog readership stats).
- **Additional branches**: The data model's branch/location concept (currently Cape Town and Durban) could be generalized to support additional Rejuvenate locations if the organization expands.
