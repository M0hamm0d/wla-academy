# Journal CMS

Decisions: D-123 … D-139 in `DECISIONS.md` (D-130 optional approval, D-131
Lovable + public API, D-132 pg_cron scheduling, D-133 time policy, D-134
preview links, D-135 inline uploads, D-136 untitled start, D-137 the
simplified studio, D-138 pasting documents, D-139 focus on writing surfaces). Open:
OPEN-23 (the real Medium export). Tables: `DATA-MODEL.md` → "Journal CMS".
Public API for Lovable: `JOURNAL-PUBLIC-API.md`.

## 1. Shape

- **WLA app (this repo)** is the CMS and backend: the studio at `/editorial`,
  the database, media, scheduling, and a public read-only JSON API at
  `/api/journal/*`.
- **Lovable** renders the public Journal at `/journal` from that API.
  There is no public Journal page in this app (`/journal` here is the
  original stub) and no second content store.

## 2. Content model

Every edit lives in a `journal_revisions` row. An article has a **working**
revision and, once published, a **live** revision (a pointer). The public API
reads only the live pointer, so editing a published article never shows the
draft: readers keep the live version until someone explicitly publishes the
new one.

Revision states: draft → (optional: in_review → changes_requested | approved)
→ live → retired; `superseded` when an approved revision is replaced by a new
draft. In-review, approved and live revisions are immutable (trigger); a
scheduled revision cannot be saved.

Display states (draft, in review, changes requested, approved, scheduled,
published, archived) are derived; a published article can also show "new
version: draft / in review".

## 3. Publishing and permissions (enforced in the database)

| | Writer (author of the article) | Writer (collaborator) | Editor | Admin |
| --- | --- | --- | --- | --- |
| Create article | ✓ | ✓ | ✓ | ✓ |
| Edit (including a published article — saved as a new draft) | ✓ | ✓ | any | any |
| Share a view-only preview link | ✓ | ✓ | any | any |
| Publish now / schedule / cancel schedule / unpublish | ✓ | | any | any |
| Add or remove people who can edit | ✓ | | any | any |
| Comment (staff-only notes) | ✓ | ✓ | any | any |
| Archive, delete never-published drafts, categories, Medium import | | | ✓ | ✓ |
| Grant roles | | | | ✓ |

- **No approval is needed to publish** (D-130), and the studio no longer
  offers review at all (D-137). The review tables, functions, role and any
  past decisions are kept; a version left in review returns to draft when next
  saved.
- Only the **working** revision can be published, named by the content hash
  the publisher last saw saved; a stale page is refused. The studio saves
  unsaved changes first, then publishes exactly that version.
- Publishing needs a title, URL slug and body, and a slug no other article uses.
- Every publish, unpublish, schedule, cancel, scheduler outcome and retry is
  in `journal_audit`, with the content hash.
- Visitors and parents cannot read any Journal table except categories; no
  client role can write any Journal table.

## 3a. The studio (D-137)

- **One writing surface**, modelled on Substack's editor: a top bar with the
  status in words and every publishing action together — **Save draft ·
  Share · Publish** (the only primary button); then the toolbar, title,
  subtitle, author and the article. History and Comments open in side panels.
- **Article Settings** (D-147: featured image, web address, category, tags,
  excerpt, date, search details): a sticky sidebar on a wide screen, and one
  button in the top bar on a smaller one. Each setting has one value, held by
  the studio and saved through the one form, so one save keeps everything.
- **New article** opens an untitled draft straight away (D-136). Its web
  address follows the title until someone sets it by hand.
- **Publish** opens **Review Before Publishing** (D-147). Opening it changes
  nothing, and anything corrected there is the editor's own value, kept by
  **Back to Editing**. **Publish Article** is the only action: *Now* or *At a
  later time* (UK time, echoed in words; see §4). It saves unsaved changes first
  and publishes exactly that saved version. Missing details (title, text, web
  address, an image's description, images still uploading) are listed with a way
  to each, and the button waits. Once the server confirms, it goes to the articles
  list, which says so; a failure stays in the review with everything intact.
- **Editing a published article**: just edit. The first save creates a new
  draft from the live version (`journal_start_revision`); readers keep the
  published version, the status reads "Published · unpublished changes", and
  **Update Article** opens the same review and replaces it. If someone else already started a newer
  version, the save is refused as a conflict rather than saved over.
- **Share** makes a **view-only preview link** (D-134): it shows the latest
  saved version to anyone holding it, for 30 days or until turned off; the
  full link is shown once. Editing is separate — add the person (they need a
  Journal account) under "Who can edit".
- **Images** (D-135): toolbar *Image*, the **+** beside an empty line, paste
  or drag-and-drop. The image appears at once with its own progress; a failure
  stays in place with *Try again* / *Remove*; a selected image offers its
  description (alt text), *Replace* and *Remove*. Photos up to 30 MB are
  resized in the browser (longest edge 2400 px); what is stored is at most
  10 MB, PNG/JPEG/WebP/GIF only, checked by the bucket, the database and the
  server's byte sniffing. Unused uploads are removed safely after saves.
- **Pasting** (D-138): text from Google Docs, Word or a web page keeps
  bold, italic, underline, strikethrough, links, lists and headings (stepped
  down one level), without the doubled blank lines; images in it are copied
  into the article, or wait in place with *Try again* / *Remove* if the source
  won't give them up.
- **Focus** (D-139): clicking into the text shows the caret only; reaching it
  with Tab shows one outline.
- **The live link** goes to the public website — set
  `NEXT_PUBLIC_JOURNAL_SITE_URL` to its origin. Unset, the studio offers its
  own read-only view of the published version instead (this app has no public
  `/journal/<slug>`, which is why the old link gave a 404).

## 4. Scheduled publishing (D-132, D-133)

**Mechanism:** Supabase **pg_cron** runs `select public.journal_publish_due()`
every minute inside the database. No page visit, browser timer, HTTP endpoint
or secret is involved, and it does not depend on the Vercel plan (Vercel Cron
on Hobby runs at most daily).

**What a run does:** every article whose `scheduled_for` has passed is
re-checked — not archived, still the working revision, publishable, content
hash unchanged since it was scheduled, the person who scheduled it can still
publish it, slug still free — and published, or its schedule is cancelled with
the reason audited.

**Safety:**
- missed runs: the next run picks up everything overdue;
- overlapping or duplicate runs: `for update skip locked` and go-live clearing
  the schedule mean an article is published exactly once (tested with two
  concurrent sessions);
- failures: each article runs in its own sub-transaction; an unexpected error
  keeps the schedule and is retried next minute (audited as a retry); after 5
  consecutive errors the schedule is cancelled and audited as failed;
- `journal_publish_due()` cannot be called by any client role.

**Visibility:** editors see in the studio whether the job is configured and
active, its last run, and how many scheduled articles are overdue.

**Time:** stored as UTC instants; scheduled in **UK time (Europe/London)**
whatever the editor's device zone, with the UTC conversion shown before
saving; a time skipped when the clocks go forward is refused; the repeated
hour in October takes the first (BST) occurrence and says so. Publication
happens within about a minute of the scheduled instant; the public API may
serve the previous state for up to ~60 s more (CDN cache).

**Deployment:**
- Local Supabase and hosted Supabase both preload pg_cron. The migration runs
  `create extension if not exists pg_cron with schema pg_catalog` and
  registers the job `journal-publish-due` (`* * * * *`) — idempotent.
- Verify after applying:
  `select jobname, schedule, active from cron.job where jobname = 'journal-publish-due';`
  and, a minute later,
  `select status, end_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'journal-publish-due' order by start_time desc limit 3;`
- If the extension cannot be created on a hosted project, the migration still
  applies, raises a warning, and the studio shows "Automatic publishing is NOT
  set up". Fix: enable pg_cron in the Supabase dashboard (Database →
  Extensions), then run the `cron.schedule(...)` line from the migration.
- Nothing is needed in Vercel and no environment variable is added.
  `NEXT_PUBLIC_SITE_URL` (already used by the QR page) is read, if set, for
  the absolute image URLs the API returns.

## 5. Files

**Schema:** `supabase/migrations/20261014120000_journal_cms.sql` (additive).

**Server:** `src/features/journal/` — `actions.ts`, `queries.ts` (studio),
`public-api.ts` + `http.ts` (public API), `content.ts` (allowlist sanitiser,
slugs), `status.ts`, `errors.ts`, `time.ts` (London time), `media.ts`,
`medium.ts`, `importer.ts`; `src/lib/permissions/journal.ts`.

**Routes:** `src/app/api/journal/{articles,articles/[slug],categories,tags,media/[id]}`,
`src/app/editorial/**` (incl. `import/upload` for Medium imports),
`src/app/(functional)/journal-preview/[token]` and `…/media/[id]` (private
previews, D-134).

**Studio code:** `components/journal/studio/article-studio.tsx` (the page),
`rich-text-editor.tsx` (TipTap, inline uploads, "+"), `features/journal/`
`upload-client.ts`, `import-client.ts`, `paste.ts`, `preview.ts`, `media-cleanup.ts`,
`public-url.ts`.

**UI:** `src/components/journal/**`; Journal link in the admin nav;
`/editorial` in the middleware's signed-in prefixes; `.wla-article-body`
typography.

**Tests:** `scripts/journal-regression.sql` (incl. sections P preview links,
U unused uploads, T untitled start) + `scripts/run-journal-regression.sh`
(isolated cluster, `cron=absent`, incl. concurrent sessions);
`scripts/run-journal-regression-local.sh` (the real local stack, `cron=present`,
one transaction rolled back, every table fingerprinted before and after — the
scheduler must be configured, active and succeeding; an undeclared environment
fails S25); `scripts/run-journal-cron-check.sh`
(real pg_cron in a throwaway container of the same image as the local stack,
migrations applied as `postgres` — the non-superuser role `supabase migration
up` uses — including a re-registration check for duplicate jobs);
`src/features/journal/__tests__/*`, `src/components/journal/__tests__/*`.

## 6. Migrations and where they are applied

| Migration | What it does | Local | Hosted staging |
| --- | --- | --- | --- |
| `20261011120000_kit_rows_follow_release` (D-114) | Family read rules for Kit rows / notes | applied 2026-10-15 | **not applied** |
| `20261014120000_journal_cms` | The Journal CMS; enables pg_cron and registers the job | applied 2026-10-15 | **not applied** |
| `20261015120000_journal_studio_simplify` (D-134 … D-136) | Preview links; safe removal of unused uploads; bucket enforces 10 MB + raster allowlist; untitled start | applied 2026-10-15 | **not applied** |

All additive. Applying to a hosted database needs explicit approval
(`supabase db push --db-url <pooler> --skip-vault`, dry run first). Then
verify as in §4 and §8.

## 7. Migrating from Medium

1. On Medium: Settings → Security and apps → **Download your information**.
2. Give someone the editor role (`/editorial/people`, admin only).
3. `/editorial/import` → upload the .zip (or post `.html` files).
4. Read the report: missing alt text, embeds not imported, links back to
   Medium, renamed slugs, failed images. Fix each in its draft.
5. Add tags (Medium's export has none) and categories.
6. Publish or schedule each article (a review is optional).
7. Re-running the same export is safe (unchanged → skipped; edited here →
   never overwritten; interrupted → resumed).

## 8. Next steps after applying

1. Sign in as the local admin, grant roles at `/editorial/people`.
2. Write → save → publish; edit the published article and confirm the API
   (`/api/journal/articles/<slug>`) still returns the old text until you
   publish again; schedule one a few minutes ahead and confirm it appears in
   the API on its own.
3. Upload an image, publish, and open its `/api/journal/media/<id>` URL
   signed out.
4. Then wire Lovable to the API (`JOURNAL-PUBLIC-API.md`).

## 9. Known limitations

- No real-time co-editing; conflicts are detected, not merged (D-128).
- Publication can lag the scheduled instant by up to a minute, plus API caching.
- External links are not checked for reachability.
- Medium embeds (video, gists, tweets) and tags need adding by hand.
- Uploaded files are never deleted (revisions refer to them).
- Search is Postgres full-text (English) over live articles.
- A renamed article returns `movedTo` from the API; Lovable must do the redirect.
