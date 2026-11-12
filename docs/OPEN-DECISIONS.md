# WLA Academy — Decision Inventory

Status as of 2026-09-26. Supersedes the review brief of the same date.

## Status key

|                                               | Meaning                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| ✅ **Resolved (provisional)**                 | Decided and recorded. Implementable. Reversible if the product direction changes. |
| 🕒 **Deferred**                               | Deliberately not built for MVP. Revisit on an explicit trigger.                   |
| 🔴 **Requires explicit decision**             | Product, privacy, legal or launch-scope. Must not be decided technically.         |
| ⛔ **Blocked by missing WLA source material** | Cannot proceed until the client supplies an approved document or asset.           |

**None of these are implemented yet.** This document records what was decided,
not what was built.

---

# ✅ Resolved (provisional)

## OPEN-01 — Public site stays in Lovable · D-25

The public website remains in Lovable. The Academy stays in this codebase.

The Lovable public site is the **visual and UX reference** for the Academy —
not a technical dependency. Nothing in this codebase may import from, call or
require Lovable at runtime. The Handover's position stands: Lovable is "a
reference, a prototype, and, where useful, a source of reusable code" and must
not become a permanent production dependency.

**Implication.** Public routes here stay minimal stubs. `/missions/[slug]`
keeps its working purchase entry so the Mission Detail → Checkout → entitlement
→ My Missions journey stays walkable (Brief §48). Cross-domain session handling
between the Lovable site and the Academy is unresolved and will need attention
before launch.

---

## OPEN-05 — Child age is metadata · D-26

Age is display information, never an access gate.

`birth_year` stays optional. Missions continue to advertise their bands
(7–11, 11–15) as guidance. No check blocks a purchase or an entitlement.

**Current state matches this already** — verified by search: `birth_year` is
stored and shown as "Born 2014", and is compared to `min_age`/`max_age`
nowhere.

---

## OPEN-08 — Resend for transactional email · D-27

Resend is approved. Scope is **essential Academy and purchase communication
only** — not a broad email system.

Initial scope: one purchase/access confirmation, sent after the webhook creates
the entitlement. No marketing, digests, reminders, re-engagement or
notification emails (notifications are deferred by Architecture §22).

**Still needed from you:** the sending domain and sender identity.

**Separate issue, unchanged by this decision.** Supabase Auth's default sender
is rate-limited and unsuitable for production. It needs a custom SMTP sender
before launch regardless of what application email exists.

---

## OPEN-09 — Sentry for error monitoring · D-28

Sentry is approved, kept deliberately lightweight.

Scope: error capture with scrubbing so mission responses, child names and child
ids never leave the system. No performance monitoring, session replay, custom
dashboards or alerting infrastructure.

Priority follows Tech Spec §33 — authentication, mission access, mission state,
progress persistence, evidence storage and completion.

---

## OPEN-10 — SQL seeds for mission content · D-29

Mission content is authored as version-controlled SQL seeds. **No CMS or admin
authoring interface is built yet.**

`supabase/seed/six_names.sql` is the worked pattern. The D-08 schema and the
`is_admin` flag already exist, so an interface can be added later without
schema change — but building one now would guess at what the first approved
Build Brief actually needs.

**Revisit trigger:** the third mission, or the first mission authored by
someone without repository access.

---

## OPEN-11 — WCAG 2.2 AA · D-30

**WCAG 2.2 AA is the MVP accessibility target.** Palette constraints are
respected while implementing it.

**Correcting my earlier statement.** I previously said AAA was not achievable
on this palette. That was wrong. Measured against Warm Cream `#F5EFE3`:

| Foreground               | Ratio      | AA normal (4.5) | AAA normal (7) |
| ------------------------ | ---------- | --------------- | -------------- |
| Charcoal Brown `#3A2F2A` | **11.3:1** | pass            | **pass**       |
| Deep Olive `#5F6A4F`     | **5.0:1**  | pass            | fail           |

Body and supporting text in charcoal already clears AAA. Olive clears AA at all
sizes, and clears AAA's 4.5:1 large-text threshold at 24px or 18.66px bold.
Only _small olive text_ falls short — which D-11 had already moved to charcoal.

So AAA is not foreclosed by the brand. AA is simply our chosen MVP target.

Already built in: global focus-visible rings, 44px touch targets, labelled
inputs with `aria-describedby` errors, `role="alert"` on failures, status never
carried by colour alone, reduced-motion support, `aria-busy` on pending
actions. **None of this has been audited** — Sprint 10.

---

## OPEN-12 — Mission Kit available indefinitely · D-31

Kit resources remain available after completion, without time limit, unless a
later retention policy explicitly changes it.

Matches Architecture §7 ("before, during and after"). No expiry logic exists in
the codebase — verified by search — so this requires no work.

---

# 🕒 Deferred

## OPEN-07 — Gift rules not yet decided · D-140, D-149

**Updated 2026-11-06 (D-149).** The client document settles delivery and expiry: the purchaser receives the code and shares it, WLA holds no recipient address, and an unredeemed code doesn't expire. So the address-based items below are gone: there is no address to mistype, match or flood with emails, and the code form now has its own per-client limit. Still not decided, and nothing invented for them:

- **Refunds:** refunds aren't handled (D-20). A gift refunded in Stripe stays redeemable until someone acts; there is no admin action for it yet.
- **A mission unpublished after purchase:** the gift can still be redeemed, as an existing entitlement would still work.
- **Edge request limit:** the code form limits each client to 10 wrong codes in 15 minutes, keyed on the first `x-forwarded-for` entry, which the host sets. A limit at the hosting edge is still worth adding before launch, and depends on the host (OPEN-27).
- **Two gifts of one mission bought back to back:** a second checkout waits until the first's webhook has arrived, as with ordinary purchases.

## OPEN-24 — The website's own accounts · D-141

The public website has its own `/auth`, `/account`, `/my-missions`, `/admin/gifts` and a legacy `gifts` table, on a different Supabase project from the Academy's. Gifting no longer uses them. **Decide** whether they should be retired in favour of the Academy's, or the projects unified.


---

# 🔴 Requires your explicit decision

_OPEN-02 is resolved — moved to the Resolved section above. See
`docs/TYPOGRAPHY.md`._

---

## OPEN-14 — Retention and deletion policy · ✅ resolved by D-148 (2026-11-06)

**Resolved by the client document "Privacy Policy Updates" (6 November 2026).** The questions are answered, and the answers are built (D-148, `docs/PRIVACY-OPERATIONS.md`):

1. **Immediate, or a grace period?** Delete without undue delay, targeting 30 days from verified closure. In practice it completes at once unless a file can't yet be removed or a lawful hold applies. There is no grace period.
2. **Export before deleting?** Yes, where feasible: "Download saved work" gives each child's missions, Trail and answers as one file, offered before closure and before removing a child.
3. **What is kept after deletion?** Financial records as the law requires: a paid order, without the family. Lawful exceptions are documented holds. Backups age out on the provider's rotation, and a restore can't bring deleted data back into use.
4. **Does deleting the parent delete the children?** Yes: every child profile, its records and its files. Deleting one child leaves the parent and siblings intact.

**Still open, and moved to OPEN-27:** the actual backup rotation period and the provider-side log retention, which need WLA's Supabase and hosting accounts. The earlier history of this item is in D-77 (superseded) and D-96.
---

## OPEN-15 — Authority documents cited by the Enhancement Plan are not in the repository · needs source files

The Enhancement Plan cites the **Mission Manual**, the **Production Brief**,
the **Child Mission** and the **Family Mission Guide** as authorities. None is
in `docs/source/`. Consequences until they arrive (D-75):

- the account page shows a Family Mission Guide placeholder, not invented copy;
- the authoring QA's age-band and child-language checks use only the rules
  that can be derived without the Mission Manual (reading-length and banned
  gamification vocabulary already prohibited by CLAUDE.md), marked advisory.

---

# ✅ Previously blocked — now unblocked

## OPEN-21 — May an author approve their own Journal revision? · RESOLVED → D-130

Approval is no longer a prerequisite for publication: an authorised author
publishes their own article. Optional reviews remain, and a reviewer still
cannot record a review of a revision they edited (it would mean nothing).

## OPEN-22 — Where does the public Journal live? · RESOLVED → D-131

On the Lovable public website at `/journal`, reading WLA's public Journal API.
The Next.js public Journal pages were removed.

## OPEN-23 — Confirm the Medium source · needs the export

No Medium export was available. Supply Medium's "Download your information"
archive (or confirm another source). Until then the importer is verified only
against fixtures built to Medium's documented export markup (D-129). Tags are
not in Medium's export and will need adding by hand.

---

## OPEN-20 — Mandatory review before publishing · needs product decision

Raised 2026-10-13 by the Mission Builder usability work (D-121). Nothing was
changed pending this decision.

**As built:** a draft can be marked "ready for review" (it must pass the
automatic checks), returned to draft, or published directly. "In review" locks
nothing and notifies no one; any admin can publish from either state. The
builder now says exactly that rather than implying an approval step exists.

**Questions:**

1. Should a version have to be "ready for review" before it can be published?
2. If so, may the person who built it also approve it, or must it be someone
   else? That needs a notion of author and reviewer the admin does not have.
3. Should anything happen when a version is marked ready — a notification is
   on the standing prohibitions list, so this would need explicit approval.

Making review mandatory would change `set_mission_version_status`'s legal
transitions (a migration) and the publish panel. Until decided, the current
transitions stand.

---

## OPEN-03 — Mission Build Brief · UNBLOCKED 2026-09-26

**Six Names Mission Build Brief v0.2** received and adopted as the working
mission specification. Stored at
`docs/source/mission-briefs/Six Names Build Brief v0.2.md`.

Sprint 9 can proceed for Six Names only. The engine registry is populated from
this brief — not invented, and not extended to any other mission.

**One caveat carried forward, non-blocking.** The brief is headed
_"Draft v0.2 — WLA approval required before production"_, §11 lists eight items
needing approval, and §12 states the narrative _"must not be treated as existing
WLA copy until approved"_. Because mission content is data (D-29 SQL seeds),
unapproved copy is cheap to revise and does not block building the mechanism.
Implementation proceeds; the copy is seeded as supplied and revisions are edits
to one seed file.

---

## OPEN-13 — Six Names assets · UNBLOCKED 2026-09-26

The standalone Child Mission document is confirmed unavailable. Its
child-facing content is now carried by §4 of the Build Brief, which is the
production source.

**Still outstanding, not blocking the build:** the four printables exist as
PNG and need print-ready PDFs at the seeded Storage paths before the mission
can be published. `published` stays `false` until then.

---


## OPEN-27 — Provider and backup verification · 🔴 needs WLA's accounts · D-148, D-153

The application side is built. What can't be confirmed from the code is listed, with exactly what's needed, in `docs/PRIVACY-OPERATIONS.md` §7:

- Supabase plan, region, backup type and retention (including Storage), and log retention, for both projects.
- Whether the Academy is on Vercel: its region, log retention, and a Vercel Cron for `/api/cron/privacy` with `CRON_SECRET`. The exact `vercel.json` and variables are in `docs/PRIVACY-OPERATIONS.md` §2, ready to approve; not added yet.
- Cloudflare's settings for the website.
- Resend's domain, region and retention, with tracking off.
- Stripe's entity and receipts.

Nothing here invents a backup period.

## OPEN-28 — The public website's privacy gaps · 🔴 needs the website's owner · D-153

Found while inventorying; these are in the Lovable project, not this repository:

- **Google Fonts** are loaded from Google's servers (`src/routes/__root.tsx`), which sends visitors' IP addresses to Google. Self-host them as the Academy does.
- **The contact form sends nothing.** `contact.tsx` only shows a thank-you, so support enquiries are neither received nor kept. Decide where enquiries go, then apply the 12-month rule.
- **Reviews** (`reviews`, which includes `reviewer_email`) have no removal or retention process. Apply "kept while necessary, then removed".
- The website's own accounts and legacy `gifts` table (OPEN-24) hold personal data under a second Supabase project.

The gift wording on its Buy a Gift page was corrected to match D-149, in the local copy only. The live site needs the same change in Lovable.

The public site's Buy a Gift handoff and gift redemption links use the Academy origin. Redemption links open the Academy's `/redeem` page in a new tab; the retained public `/redeem-gift` route now offers a manual link there instead of running the legacy flow. The website's `/admin/gifts` still shows the legacy `gifts` records with purchasers' names and emails. It doesn't display the old codes, but `adminListGifts` selects every column, so the codes still reach an administrator's browser (OPEN-24).

## OPEN-31 — The reviews table has no migration, and holds reviewers' details · 🔴 needs the developer and WLA · D-158

The admin Reviews page (PR #2) reads a `reviews` table that exists only on the hosted database: no migration in this repository creates it, so a database built from the migrations (local, a restore rehearsal, a new environment) has no reviews and the page can't load. It stores `reviewer_name` and `reviewer_email`, and it isn't described in `docs/DATA-MODEL.md`, so it isn't covered by account closure, the retention schedule or the deletion ledger (D-148, D-157).

**Decide:**
1. The developer adds the table's real definition (columns, RLS, grants) as a migration dated before `20261103090000`, written `create table if not exists` so the hosted database is unaffected, and documents it in `docs/DATA-MODEL.md`.
2. WLA decides how long a review and the reviewer's email are kept, and whether a review is removed or anonymised when its author closes their account.

**Until then:** `20261103090000` applies its policies only where the table exists, and the Reviews page works only against the hosted database.

## OPEN-30 — Where the deletion ledger is kept · 🔴 needs WLA · D-157

Deletions are now written to a ledger that must survive a database restore, so it can't live in the database, or in this project's Storage (whose records are in the database). The code writes it to a directory (`PRIVACY_LEDGER_DIR`) under a key (`PRIVACY_LEDGER_KEY`). That works locally and on any server with a lasting disk. **Vercel has no lasting disk**, so for the Academy as intended, WLA must choose a separate, access-controlled place to keep it, for example a storage bucket in a different account with versioning turned on. Then a small sink for it is added beside the directory one.

**Decide:**
1. Where the ledger is kept, and who can read it: the restore operator only.
2. Who holds `PRIVACY_LEDGER_KEY`, and where a copy is kept for a restore (not in the database, and not only in Vercel).
3. How long ledger entries are kept. They are ids and dates only, and are needed for as long as any backup that predates them can be restored.

**Until then:** closures run as before, and `/admin/privacy` warns that restoring an older backup could bring deleted families back. Do not restore a production backup without the ledger: the procedure in `docs/PRIVACY-OPERATIONS.md` §3 refuses to finish without one.

## OPEN-29 — Terms & Conditions to align the checkout statements with · 🔴 needs WLA · D-152

The site's `/terms` is still a placeholder. The checkout statements and the order confirmation follow the Consumer Contracts Regulations 2013, and link to the Terms once `NEXT_PUBLIC_TERMS_URL` is set. WLA should confirm the wording against its published Terms (14-day cancellation, digital content supplied at once) and give the URL.


---

# Summary

|     | Item                  | Status                                     |
| --- | --------------------- | ------------------------------------------ |
| 01  | Public site — Lovable | ✅ D-25                                    |
| 02  | Typefaces             | 🔴 D-33 — method set, needs Lovable access |
| 03  | Mission Build Brief   | ⛔                                         |
| 05  | Child age             | ✅ D-26                                    |
| 07  | Gift rules            | 🕒 D-140, D-149: refunds and unpublished missions only |
| 08  | Transactional email   | ✅ D-27                                    |
| 09  | Error monitoring      | ✅ D-28                                    |
| 10  | Mission authoring     | ✅ D-29                                    |
| 11  | Accessibility         | ✅ D-30                                    |
| 12  | Kit retention         | ✅ D-31                                    |
| 13  | Six Names assets      | ⛔                                         |
| 14  | Retention policy      | ✅ D-148                                   |
| 20  | Review before publish | 🔴 needs you — see OPEN-20 below            |
| 21  | Journal self-approval | ✅ D-130 — approval optional                |
| 22  | Public Journal home   | ✅ D-131 — Lovable, via the WLA API         |
| 23  | Medium source         | ⛔ needs the Medium export                  |
| 24  | Website's own accounts | 🔴 needs you — see OPEN-24 above           |
| 27  | Provider and backup verification | 🔴 needs WLA's accounts      |
| 28  | Website privacy gaps  | 🔴 needs the website's owner               |
| 29  | Terms for checkout    | 🔴 needs WLA                               |
| 30  | Deletion ledger location | 🔴 needs WLA: blocks a safe restore      |
| 31  | Reviews table          | 🔴 no migration; reviewer data not in closure or retention |

**14 resolved · 1 deferred · 5 need you (OPEN-20, OPEN-24, OPEN-27, OPEN-28, OPEN-29) · 1 blocked on source material (OPEN-23).**

---

## Implementation status — unchanged by this document

Nothing above is built. Separately, and unaffected by these decisions:

**Verified by automated tests (157):** the pure mission engine, both
behavioural session tests, auth and child-profile validation, price formatting,
and the structural guards.

**Reviewed statically only — asserts source text, not behaviour:** all SQL
semantics, webhook ordering and idempotency, redirect guards,
account-enumeration protection, price authority.

**Not verified at all — requires the live environment:** every RLS policy, the
three Postgres functions, storage policies, Stripe signature verification,
webhook delivery, retry and duplicate handling, concurrency, and the end-to-end
payment flow. **None of these may be described as runtime-verified until tested
against live or test Supabase and Stripe.**

## OPEN-25 — Covers on the Academy's public pages · D-146, D-109

Covers now display on the Academy's public pages, but those pages still list only the temporary hard-coded catalogue (D-109), which has Six Names alone. A new mission shows on the public website and in My Missions, not on Academy public pages. Decide whether those pages stay, or the website alone is the public catalogue.

## OPEN-26 — Descriptions for uploaded covers · D-146

A mission cover has no description field, so an uploaded cover has empty alt text unless it is written into `SUPPLIED_COVER`. The title always sits beside the image, so this is permitted (`covers.ts`), but Six Names' photograph is the only one described. Decide whether administrators should write one.
