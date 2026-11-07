# WLA Academy — table-to-requirement mapping

Every table, why it exists, and whether the MVP needs it. Produced before any
further schema work, per the client instruction of 2026-09-25.

**Rule applied throughout:** no table exists for a deferred feature. Mission
Board contribution/moderation, mission replay, My Missions search/filter and
notifications have **no schema** and must not acquire any (Architecture §22).

---

## Core Academy tables (migration `20260925220000_init.sql`)

### 1. `profiles`

|                   |                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**       | The parent/guardian account. Extends `auth.users` with the minimum WLA needs.                                                                    |
| **Source**        | Tech Spec §6; Architecture §3 ("the parent owns the account, access and permissions")                                                            |
| **MVP**           | **Required.** Everything hangs off it.                                                                                                           |
| **Relationships** | `auth.users` 1:1 → `profiles` 1:N → `child_profiles`                                                                                             |
| **Notes**         | Tech Spec §6: "Do not collect additional personal information simply because the database could accommodate it." Four columns; keep it that way. |

### 2. `child_profiles`

|                   |                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**       | The learner identity that owns mission progress and the learning record.                                                       |
| **Source**        | Tech Spec §7; Architecture §3; PRD §7.2                                                                                        |
| **MVP**           | **Required.** Multi-child support is locked, not optional.                                                                     |
| **Relationships** | `profiles` 1:N → `child_profiles` 1:N → entitlements, progress, evidence                                                       |
| **Notes**         | `birth_year` only, not full DOB — Brief §46 forbids unnecessary sensitive child data. Whether age gates access is **OPEN-05**. |

### 3. `missions`

|                   |                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | The mission definition. What the mission _is_ — never what a child has done.                                                                                                  |
| **Source**        | Tech Spec §9; PRD §17                                                                                                                                                         |
| **MVP**           | **Required.**                                                                                                                                                                 |
| **Relationships** | 1:N → screens, resources, entitlements, progress; 1:1 → parent note                                                                                                           |
| **Notes**         | Carries commercial data (`price_minor`, `currency`) so UI never hard-codes either. `version` supports Tech Spec §53 so editing a live mission cannot corrupt in-flight state. |

### 4. `mission_screens`

|                   |                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | Mission _content_, rendered by the shared engine. `type` selects the component.                                                                          |
| **Source**        | Tech Spec §15–§16; PRD §16                                                                                                                               |
| **MVP**           | **Required** — this is what makes missions configuration rather than code.                                                                               |
| **Relationships** | `missions` 1:N → `mission_screens`                                                                                                                       |
| **Notes**         | Currently **empty by design**: no approved Build Brief (OPEN-03). `configuration` JSON is validated by zod in the engine, per Tech Spec §12's condition. |

### 5. `mission_resources`

|                   |                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | Mission Kit — what WLA gives the child.                                                                                                       |
| **Source**        | Tech Spec §19; Architecture §7                                                                                                                |
| **MVP**           | **Required.** Six Names alone has five.                                                                                                       |
| **Relationships** | `missions` 1:N → `mission_resources`; files in the `mission-resources` bucket                                                                 |
| **Notes**         | Per-resource `can_view` / `can_print` / `can_download` so UI shows only applicable actions (UI/UX §30). Reads here must never write progress. |

### 6. `mission_parent_notes`

|                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**         | The Mission Note for Parents.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Source**          | Tech Spec §21; Architecture §8                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **MVP**             | **Required.**                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Relationships**   | `missions` 1:1 → `mission_parent_notes` (unique on `mission_id`)                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Notes**           | Belongs to the mission, not the child. Separate table rather than a `missions` column because it is long-form and separately edited.                                                                                                                                                                                                                                                                                                                                   |
| **`document_path`** | Added 2026-09-27. Optional print-ready note in the private `mission-resources` bucket, under the mission's own folder, so the existing bucket policy covers it unchanged. Deliberately NOT a `mission_resources` row: that table is the child's Mission Kit, and Architecture §8 keeps For Parents separate from it (Brief §17 forbids the two collapsing into one "files" area). NULL means the note is text only, and For Parents falls back to rendering `content`. |

### 6b. `analytics_events` (added 2026-09-28)

|                   |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | ANALYTICS-01 — mission starts and completions are countable.                                                                                                                                                                                                                                                                                                                                                                     |
| **Source**        | PRD §32; Tech Spec §42; Brief §53                                                                                                                                                                                                                                                                                                                                                                                                |
| **MVP**           | **Required** (ANALYTICS-01 is a Should; OPS-02 versioning is a Must).                                                                                                                                                                                                                                                                                                                                                            |
| **Relationships** | `missions` 1:N → `analytics_events`. Deliberately NOT related to a child.                                                                                                                                                                                                                                                                                                                                                        |
| **Notes**         | Stores `name`, `mission_id`, `mission_version`, `occurred_at`. **No child id, no progress id, no parent id, no content.** The child id is an authorisation input to `record_mission_event()` and is discarded. RLS is on with **no client policy at all** — writes go through the definer function, reads through `admin_mission_stats()`. Drop-off is derived from `mission_progress`, never tracked as an event (conflict C7). |

### 7. `mission_entitlements`

|                   |                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**       | Does this child have access to this mission?                                                                                                                                                                                                                 |
| **Source**        | Tech Spec §10; PRD §9; Architecture §3                                                                                                                                                                                                                       |
| **MVP**           | **Required.** "Catalogue ≠ entitlement ≠ progress."                                                                                                                                                                                                          |
| **Relationships** | `child_profiles` N:M `missions`, unique on `(child_id, mission_id)`                                                                                                                                                                                          |
| **Notes**         | `source` records free/purchase/gift/redeemed/admin, but **access logic never branches on it** — the Academy asks whether access is valid, not why it was granted. No client insert policy exists; only the verified Stripe webhook writes paid entitlements. |

### 8. `mission_progress`

|                   |                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | Status and position for one child in one mission.                                                                                                                                      |
| **Source**        | Tech Spec §11, §50; Architecture §19                                                                                                                                                   |
| **MVP**           | **Required.**                                                                                                                                                                          |
| **Relationships** | `child_profiles` + `missions` → `mission_progress`, unique on `(child_id, mission_id)`                                                                                                 |
| **Notes**         | Keys on `child_id`, never `parent_id` (Tech Spec §50). The unique constraint enforces Tech Spec §27's "no duplicate progress records" in the database rather than in application code. |

### 9. `mission_state`

|                   |                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | Mission-specific persisted state: visited screens, choices, reveals, confirmed handoffs.                                                                                                          |
| **Source**        | Tech Spec §12–§13; Architecture §19                                                                                                                                                               |
| **MVP**           | **Required** for pause/resume, which is an MVP requirement (PRD §19).                                                                                                                             |
| **Relationships** | `mission_progress` 1:1 → `mission_state`                                                                                                                                                          |
| **Notes**         | A single JSON column on purpose. Tech Spec §13 explicitly rejects a table-per-concept design; Architecture §19 forbids forcing every mission into one internal sequence. Validated by the engine. |

### 10. `mission_responses`

|                   |                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | The child's saved answers, one row per screen.                                                                                                                                                                                                                |
| **Source**        | Tech Spec §49; PRD §18                                                                                                                                                                                                                                        |
| **MVP**           | **Required** where a mission asks for a response.                                                                                                                                                                                                             |
| **Relationships** | `mission_progress` 1:N → `mission_responses`, unique on `(progress_id, screen_key)`                                                                                                                                                                           |
| **Notes**         | Split out of `mission_state` so Mission Trail can surface a child's own words without parsing an opaque blob. **Could be deferred** into `state_data` if you want a smaller MVP — but retrieving Trail content would get materially worse. Recommend keeping. |

### 11. `mission_evidence`

|                   |                                                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | Mission Trail — the child's private record of selected evidence.                                                                                                                                                                                                            |
| **Source**        | Tech Spec §22–§23; Architecture §15                                                                                                                                                                                                                                         |
| **MVP**           | **Required.** TRAIL-01 is a Must.                                                                                                                                                                                                                                           |
| **Relationships** | `child_profiles` + `missions` → `mission_evidence`; digital files in the `mission-evidence` bucket                                                                                                                                                                          |
| **Notes**         | `type` distinguishes physical from digital, with a CHECK constraint forcing digital evidence to carry a `storage_path` and permitting physical to have none. This is the database enforcing Brief §27's rule that the Academy must not imply it stores a physical artefact. |

---

### 11b. `mission_state_private` (added 2026-10-04, migration 0027)

|                   |   |
| ----------------- | - |
| **Purpose**       | The server-only half of a run's state: hidden variables, the randomisation seed, fired events, the assigned variant. |
| **Source**        | Enhancement Plan §3 (hidden variables, variants, randomisation); D-80 |
| **MVP**           | **Required** by current scope (the Enhancement Plan). |
| **Existing table?** | Not `mission_state`: families can read their own state, and these values must never reach a client. A column with a column-level grant was rejected because the whole row is read by family queries. |
| **Child data**    | No personal data — mission mechanics only, keyed on the run. |
| **Notes**         | No client grants at all; read and written only by `engine_load_run` / `engine_save` (service role). |

### 11c. `mission_assets` (added 2026-10-04, migration 0032)

|                   |   |
| ----------------- | - |
| **Purpose**       | Media a screen shows — images, diagrams, maps, animation, audio, video — pinned to a mission version, with alt text, long description, transcript and captions. |
| **Source**        | Enhancement Plan §7 (F7); §12 asset management; Architecture §20 (accessibility) |
| **MVP**           | **Required** by current scope. |
| **Existing table?** | Not `mission_resources`: that is the Mission Kit — what WLA gives the family to print and keep, listed on the Kit page (Brief §17). Screen media is never a file the family browses; folding it in would list every diagram in the Kit. |
| **Child data**    | None. WLA-authored content only. |
| **Notes**         | No client grants; admins author through draft-only functions; learners receive server-signed URLs for the current screen only. Immutable once published; copied by new versions and duplicates. Private bucket `mission-media`. |

---

### 11d. `board_contributions` (added 2026-10-04, migration 0036)

|                   |   |
| ----------------- | - |
| **Purpose**       | The Mission Board: an anonymised copy of one eligible Trail entry that a parent permitted and WLA moderates. |
| **Source**        | Enhancement Plan §9; Architecture §16 as amended; D-73, D-96 |
| **MVP**           | **Required** by current scope (the Board was deferred until the Enhancement Plan lifted it). |
| **Existing table?** | Not `mission_evidence`: that is the child's private Trail. The Board holds a separate, scrubbed and moderator-editable COPY, so publishing never changes or exposes the private record, and withdrawal deletes only the copy. |
| **Child data**    | Child-written text, shared only with parent permission, scrubbed of family names, contact and location detail, and reviewed by WLA before display. No images, no author, no counts. Deleted at once on withdrawal or child deletion; any longer retention is OPEN-14. |
| **Notes**         | No client grants; families and children reach it only through ownership-checked or token-derived functions; admins never see child identity. |

---

## Content tables (migration `20260925220100_editable_content.sql`)

Added to satisfy **CMS-01**, which is a Must. Decision D-08 / conflict C3.

### 12. `journal_categories` · 13. `journal_articles`

|                   |                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**       | Editable Journal content.                                                                                                                |
| **Source**        | PRD §28; Tech Spec §39; CMS-01                                                                                                           |
| **MVP**           | **In scope since D-123** (Journal CMS). Extended, not replaced, by the Journal CMS migration — see the Journal section below.            |
| **Relationships** | `journal_categories` 1:N → `journal_articles`                                                                                            |
| **Notes**         | Safe to drop from the first deployment if the public site stays on its existing implementation. Nothing in the Academy reads them.       |

`profiles.is_admin` was added in the same migration — a manual flag with no
self-service route, gating the eventual admin.

---

## Journal CMS (migration `20261014120000_journal_cms.sql`, D-123 … D-129)

Requirement: CMS-01 / PRD §28 "Journal articles; Journal categories", made a
current requirement by the Journal CMS brief of 2026-10-14 (D-123), which
names collaborative editing, internal comments, mandatory approval of an
exact version, scheduling, revision history and Medium migration.
**None of these tables holds child data** (Brief §46): the only people in them
are staff accounts, by profile id.

The existing `journal_articles` and `journal_categories` are **extended, not
duplicated**. `journal_articles` also carries the schedule (`scheduled_for`,
`scheduled_revision_id`, `scheduled_by`, `scheduled_hash`,
`schedule_attempts`) used by the pg_cron job (D-132). `journal_articles` becomes identity + live pointer; its 0002
content columns are relaxed (nullable), kept, and backfilled into revision 1.

| Table | Requirement it serves | Why an existing table can't carry it |
| --- | --- | --- |
| `journal_staff` | Writer / reviewer / editor roles (D-124) | `profiles.is_admin` is one flag; three roles with different powers need rows. Admins keep all powers. |
| `journal_revisions` | Versions, preview, publication of an exact version, live preserved while a new version is drafted | Publication and review bind to an immutable snapshot; one row per article cannot hold "live" and "being edited" at once. |
| `journal_media` | Featured and inline images; public only while live | Mission media is per mission version and admin-only; the visibility rule here is different. |
| `journal_article_members` | Who may edit an article (collaboration) | — |
| `journal_review_assignments` | Reviewer assignment | — |
| `journal_review_decisions` | Optional formal approve / request-changes, bound to a content hash (D-130: never a publishing gate) | A decision is a record of its own, not an audit line. |
| `journal_comments` | Internal editorial comments (staff-only) | — |
| `journal_revision_changes` | Change attribution (who saved which fields) | — |
| `journal_audit` | Auditability of workflow events | No FK to the article, so the record survives a deleted draft. |
| `journal_import_sources` | Duplicate detection / safe re-import (Medium post id → article) | — |
| `journal_import_runs`, `journal_import_items` | Import reports | — |
| `journal_preview_links` (migration `20261015120000`, D-134) | Share a private, view-only preview of a draft with someone without an account; revocable | No existing table holds a bearer credential. It stores only the SHA-256 of each token, its article, who made it, when it expires and whether it was turned off — no content and no child data. |

No client role may write any of these; every write is a `journal_*`
security-definer function. Anon has no SELECT on any of them except the
publicly readable `journal_categories`. Holders of a preview link reach the
latest saved version of one article only through `journal_preview_article`
and `journal_preview_media_path`.

Migration `20261015120000` also: lets the `journal-media` bucket enforce
10 MB and the raster allowlist itself; adds a storage DELETE policy that only
ever allows removing an UNREGISTERED file (D-135); and lets an article start
untitled (D-136). Review tables are kept — review is simply no longer offered.

---

## Summary

| Required now                                                                                                                                                                   | Deferrable                                                                                              | Must not exist                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| profiles · child_profiles · missions · mission_screens · mission_resources · mission_parent_notes · mission_entitlements · mission_progress · mission_state · mission_evidence | mission_responses (foldable into `state_data`, not recommended) · journal_categories · journal_articles | Mission Board submissions/moderation · replay history · search indexes · notification queues · points/badges/streaks · public profiles |

**Ten tables are genuinely load-bearing for the Academy MVP.** The count is
proportionate: each maps to a Must-priority requirement, and the two most
easily over-engineered areas — mission state and mission content — are
deliberately one JSON column and one generic table rather than the "dozens of
tables" Tech Spec §13 warns against.

### `mission_gifts` (migration `20261030120000`, D-140)

1. **Requirement:** PRD §31, Brief §50, Tech Spec §41: the purchaser and the receiving family may be different people.
2. **Must:** yes. The client brief of 2026-10-30 makes it one (D-32 deferred it until then).
3. **Can an existing table carry it?** No. `checkout_intents.child_id` and `mission_entitlements.child_id` are NOT NULL, because both describe a child; a gift has no child until it is redeemed.
4. **Child data?** Only `redeemed_child_id`, a reference that is set null if the profile is deleted. The recipient address is an adult's. No client role can read the table.

Migration `20261030130000` adds `claim_hash` and `confirm_failures` to this table (D-142). No new table.

### Before adding any table, answer:

1. Which numbered requirement does it serve?
2. Is that requirement Must, or is it deferred by Architecture §22?
3. Can an existing table carry it without becoming incoherent?
4. Does it store child data that Brief §46 says not to collect?

If 2 is "deferred", stop.

### No new tables for D-143 to D-146

Each of these extends an existing table, answering "can an existing table carry it?" with yes. None collects new child data (Brief §46): `creation_key` is a random value, and the access code is the same code in encrypted form.

| Migration | Table | Columns | Why |
|---|---|---|---|
| `20261030140000` | `child_access_credentials` | `code_ciphertext`, `code_last_viewed_at`, `has_viewable_copy` | A parent can view the active code (D-143). `code_ciphertext` is outside the client grant. |
| `20261030150000` | `child_profiles` | `creation_key` | Adding a child is safe to retry (D-144). |
| `20261030160000` | `mission_gifts` | `code_hash`, `code_expires_at`, `code_failures`, `code_sent_at`, `claim_expires_at` | Redeeming from the website with a code, and claims that expire (D-145). |
| `20261030170000` | `storage.buckets` | the `mission-covers` bucket and its policies | Mission covers (D-146). `missions.cover_image` already existed. |

`app_secrets` gains the row `gift_code_pepper`.


### Privacy and gifting, 6 November 2026 (D-148 to D-152)

Five new tables, each answering the four questions above:

| Table | 1. Requirement | 2. Must? | 3. Could an existing table carry it? | 4. New child data? |
|---|---|---|---|---|
| `privacy_deletions` | Verified closure within 30 days, failures visible, deletions re-applied after a restore (client document of 6 Nov 2026, §1; resolves OPEN-14) | Must: a legal requirement for children's data, not deferred by §22 | No: it must outlive the account and children it records | No: ids and dates only, kept for the restore safeguard |
| `privacy_deletion_files` | The same: no stored file forgotten once its rows are gone | Must | No: the rows that point at files are what is being deleted | A file path, until the file is removed; then the row goes |
| `retention_holds` | "Lawful exceptions", investigation exceptions, annual review of case-specific records (§1) | Must | No: a hold covers subjects across tables | No: a reason written by WLA, with no child's details |
| `retention_runs` | Evidence that the retention rules ran (§9, "operational evidence") | Must | No | No: counts only |
| `gift_code_attempts` | Protection against repeated incorrect gift codes (§5, the brief's security requirements) | Must | `child_auth_attempts` is for child codes and keyed on the code; this is keyed on the client | No: an HMAC of a network address, deleted after 90 days |


### The deletion ledger, 7 November 2026 (D-157)

| Table | 1. Requirement | 2. Must? | 3. Could an existing table carry it? | 4. New child data? |
|---|---|---|---|---|
| `privacy_ledger_outbox` | "Safeguards against restoring deleted information" (client document of 6 Nov 2026, §1): each privacy event, recorded in the same transaction, until the server has copied it to the ledger outside the database | Must | No: `privacy_deletions` is overwritten as a closure progresses and doesn't record holds or Board removals as events | No: ids and dates only; pruned 30 days after copying |
| `privacy_ledger_head` | The same: how far the external ledger had reached, so a restore can tell a cut-short or foreign ledger from the right one | Must | No | No: a sequence number and a hash |

Columns added to existing tables:

| Migration | Table | Columns | Why |
|---|---|---|---|
| `20261106120500` | `mission_gifts` | dropped `recipient_email`, `redeem_token_hash`, `link_sent_at`, `confirm_failures`, `code_hash`, `code_expires_at`, `code_failures`, `code_sent_at`; added `code_lookup`, `code_ciphertext`, `code_issued_at` | The purchaser holds the code; no recipient data (D-149). Less personal data than before. |
| `20261106130000` | `checkout_intents` | `paid_at`, `stripe_payment_intent_id`, `early_supply_consent_at`, `cancellation_ack_at`, `consent_wording`, `confirmation_sent_at`; `parent_id` and `child_id` now nullable, set null on delete | Consent and confirmation records (D-152). A paid order kept as a financial record without the family (D-148). |
| `20261106130000` | `mission_gifts` | the same four consent and confirmation columns | D-152 |
| `20261106120000` | `checkout_intents`, `mission_gifts` | `attempt_key`, `checkout_status`, `mission_title`, `mission_description`, `mission_slug`, `customer_email` (the parent's own address, for Stripe), `site_origin`; `stripe_session_id` nullable while the session is created | Durable checkout attempts (developer, PR #2; D-158). `customer_email` is cleared when the family link is (`20261107150000`, D-148) |
| `20261106150000` | `board_contributions` | `rejected_reason`, `anonymity_checked_at`, `anonymity_checked_by` | Anonymity confirmed before publishing, and kept private otherwise (D-151) |
