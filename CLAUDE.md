# WLA Academy — working rules

Read `docs/DECISIONS.md` before starting any task.

## Authority order

1. **Academy Architecture** (LOCKED — `docs/source/`), as amended by the
   **Academy Enhancement Plan** (`docs/source/WLA Academy Enhancement Plan.md`,
   approved current scope, 2026-10-04)
2. **Public Website Master**
3. **Mission Build Brief** (none approved yet)
4. **Designer Brief / UI-UX Specification**
5. **Technical Specification**
6. Developer judgement

When two of these disagree, **stop and record it in `docs/DECISIONS.md`**.
Do not resolve a product conflict in code (Tech Spec §55).

## The two rules that shape everything

**1. Build the capability once; configure missions within it.** (Tech Spec §62)

Never create `MarsBridgeBuilder.tsx`. Never write `if (missionId === "mars")`.
A new mission is rows in `missions` / `mission_screens` / `mission_resources`,
never new application structure. If a mission seems to need new code, it needs
a new _screen type_ — one entry in `features/mission-engine/registry.ts` plus
its zod schema — and that is a product decision, not a shortcut.

**2. Progress keys on `child_id + mission_id`.** (Tech Spec §50)

Never `parent_id`. The parent owns the account; the child profile owns the
learning record. This is locked by Architecture §3.

## Access control — non-negotiable

There are no child accounts. The authenticated user is the **parent**, who owns
the account, access and permissions. Child profiles own mission progress and
the learning record.

**Sibling separation is enforced by server and database authorisation**, not by
interface behaviour. Every child-scoped operation validates, in order:

1. authenticated parent session — `requireParent`
2. requested child belongs to that parent — `requireOwnedChild`
3. child has the required entitlement — `requireEntitledMission`
4. requested progress/state/evidence belongs to that child —
   `requireOwnedProgress` · `requireOwnedState` · `requireOwnedEvidence`

Never trust a `childId` from the browser — **or a progress, state or evidence
id.** Holding a valid record id is not authorisation. Each check re-asserts the
boundary _inside the query_.

Cross-family isolation is absolute and additionally enforced by RLS.

Switching the active child must switch the **entire** Academy context. Use
`switchActiveChildAction`, which revalidates the Academy layout. There must be
no path by which Child A's data appears while Child B is selected.

Do not add signed active-child tokens. The ACTIVE-CHILD cookie carries no
authority and must not gain any.

Children authenticate separately with an access code (D-58), which supersedes
the earlier ban on child authentication. That is a session scoped to one child
profile — not a child *account*: no email, no password, no purchases, no family
management. Child-scoped data is reached only through `child_session_*`
functions, which derive the child from the token inside the database and never
take a child id as an argument.

`src/lib/supabase/admin.ts` bypasses RLS. Its only legitimate uses are the
Stripe webhook, gift purchase and redemption (D-140, D-149), reconciling unfinished
checkouts from the cron route (D-158), account closure and
child-profile deletion **after** the parent or an erasure request is verified
(D-148), copying the deletion ledger outside the database (D-157), signing a Mission Kit file for a child
session **after** `child_session_resource_path` has authorised it (D-64),
signing a Journal image for a private preview link **after**
`journal_preview_media_path` has authorised it (D-134), storing and reading the
encrypted copy of a child's code **after** `requireOwnedChild` (D-143), and
the **mission engine store** (`features/mission-engine/store.ts`, D-80), which
loads and saves a run — and signs the current screen's media (D-89) — only
after the permission chain or the child-session lookup has authorised it. In both of the last two it acts on something already
authorised — it never decides.

**Mission state is server-authoritative (D-80).** No client role may write
`mission_progress`, `mission_state`, `mission_responses` or `mission_evidence`,
or call a function that does. Every learner change goes
`runtime.step` (pure) → `store.saveRun` → `engine_save` (service role). Never
grant a client write path to run state, and never send the browser more than
`projection.ts` produces. If you reach for it while serving a logged-in parent,
you are almost certainly doing something wrong.

## Locked product behaviour — do not redesign

| Surface                     | Rule                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| My Missions                 | Collection + status only. Not a dashboard, not a file store.                                                                      |
| Mission Home                | Permanent. Exists before, during and after. Start/Continue is the strongest action; Mission Kit and For Parents stay subordinate. |
| Mission Kit                 | What WLA _gives_. Opening, printing or downloading **must not touch progress**.                                                   |
| Mission Trail               | What the child _generates_. Private by default. Physical evidence is recorded, never faked as stored.                             |
| Mission Kit ≠ Mission Trail | These must never collapse into one "files" area (Brief §17).                                                                      |
| For Parents                 | Adult guidance. Not a parent dashboard. Opening it must not change state.                                                         |
| Mission Control             | Optional, secondary, calm. Never advances the mission, never reveals concealed content, never solves it.                          |
| Active Mission              | The quietest surface. Cream + charcoal; olive only for the primary action.                                                        |
| Completion                  | Closure, not performance. No confetti, scores, badges or upsell.                                                                  |
| Status                      | `Not Started → Start Mission`, `In Progress → Continue Mission`, `Complete → View Mission` (D-65). The pairing is locked: the action comes from STATUS, never from the route taken. |
| Pause/resume                | Normal behaviour, not an edge case. State lives in Supabase, never only in localStorage.                                          |

## Naming trap

**"Mission Board" means two different things.** See conflict C8.

- _Six Names Mission Board_ — a printable worksheet. A Mission Kit resource.
- _Mission Board_ (Architecture §16, amended) — the Academy-wide shared-practice
  destination beneath the child's mission collection on **My Missions**. In
  scope since the Enhancement Plan, with parent permission, anonymisation and
  WLA moderation before anything appears (D-73).

Never let a Build Brief's use of the phrase confuse the two.

## Design system

Use tokens from `src/styles/tokens.css`. Never hard-code a hex value.

- Warm Cream carries the system. Olive is deliberate. Sage supports. Clay accents.
- Status must **never** be carried by colour alone (Architecture §20).
- Do not default to cards (Brief §34). Plain content on cream is usually right.
- Shadows are "paper lifted from a surface", not floating software.
- Every interactive element needs a visible focus state and a 44px touch target.
- No hover-dependent core interaction.

## Seeds are apply-once

`supabase db push --include-seed` may record a changed seed's new hash
**without executing it** — observed on staging, where an edited price silently
stayed NULL. Never treat a successful push as proof that content changed.

To revise already-applied content: an explicit UPDATE (see
`supabase/seed/six_names.sql`), a NEW seed file added to `[db.seed].sql_paths`,
or a migration. **Verify the data afterwards.** Do not restructure seeding or
the application to work around this.

## Before adding a database table

Answer, in `docs/DATA-MODEL.md`: which numbered requirement does it serve; is
that requirement Must or deferred; can an existing table carry it; does it
store child data Brief §46 says not to collect. If deferred — stop.

## Never add without written approval

points · badges · streaks · rankings · leaderboards · gamification · confetti ·
social profiles · chat · comments · likes · notifications · mission replay ·
public Trail sharing (outside the moderated Mission Board) · compulsory uploads ·
parent dashboard · AI tutor · global file library

Approved since, and no longer on this list: no-code mission builder (D-56),
My Missions search/filter (D-60), Mission Board contribution with permission,
anonymisation and moderation (Enhancement Plan, D-73). The Enhancement Plan's
interaction, logic and authoring capabilities are current scope — build them as
shared configuration (`docs/FOUNDATION-ARCHITECTURE.md`), never per mission.

These are deferred or prohibited by Architecture §22, PRD §5, Tech Spec §60 and
UI/UX §76. Technical ease is not a reason to add one.

## Commands

```
npm run dev        # http://localhost:3000
npm run build
npm run typecheck
npm test           # mission engine navigation/branching/reveal tests
npm run lint
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
