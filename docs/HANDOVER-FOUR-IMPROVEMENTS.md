# Handover: four WLA improvements

Branch: `feature/wla-four-improvements`, based on `academy-mvp`. It holds two commits
that aren't on `origin/academy-mvp`: the mission gifting checkpoint (`cbebf54`, which
the rest builds on) and the four improvements.

**Nothing here has been deployed, and no hosted database has been changed.**

> **Updated 2026-11-06:** gift delivery by recipient email (D-145, and the `/redeem` email limit below) is superseded by D-149. The purchaser receives the code and shares it; there is no recipient address and no gift email. Four further migrations (`20261106120000` to `20261106150000`) follow the six below. See `docs/PRIVACY-OPERATIONS.md`.

| Improvement | Decision | Where to start |
|---|---|---|
| Gift redemption by emailed code | D-145 | `src/features/gifts/`, `src/components/commerce/redeem-forms.tsx` |
| Adding a child during purchase or redemption | D-144 | `src/components/commerce/child-picker.tsx` |
| Viewing and replacing a child's access code | D-143 | `src/features/child-auth/`, `docs/CHILD-CODE-ENCRYPTION.md` |
| Mission cover uploads | D-146 | `src/components/admin/mission-cover-field.tsx`, `src/features/admin/cover-actions.ts` |

## Outstanding security requirement: limit `/redeem` requests

**This must be done before launch.** Nothing limits request volume on `/redeem`. Gifts
are protected per link, per code and per gift, but anyone can type a recipient's address
and cause up to 30 code emails an hour to reach them. Add a request limit at the hosting
edge, covering both "Email me a code" and the code check. Recorded in OPEN-07.

## Not yet tested

- **Real Resend delivery.** Local runs delivered to Mailpit, and failed sends are covered
  by unit tests only.
- **Real Stripe webhook delivery.** Payments went through Stripe's hosted test page, but
  no `stripe listen` was running. The test script fetched the paid session and delivered
  a correctly signed webhook itself.
- **Staging acceptance scripts** (`scripts/browser/acceptance/`). Their button labels were
  updated but they weren't run. Where a code already exists, they also need to confirm the
  new replacement dialog.
- **The cover field at phone width.** It was only checked at desktop width.
- **In a browser, rather than at database level:** code expiry and the five-attempt limit.

## Migrations

All six have been applied to a local database only. Apply them in this order, and never
run `supabase db reset` against shared data.

1. `20261030120000_mission_gifts` (in the checkpoint)
2. `20261030130000_mission_gift_claims` (in the checkpoint)
3. `20261030140000_child_code_encrypted_copy`
4. `20261030150000_child_creation_key`
5. `20261030160000_gift_verification_codes`
6. `20261030170000_mission_covers`

Locally, use `supabase migration up --local`, which keeps existing data.

**Six Names:** none of these migrations change mission content, and this branch changes
no seed. Keep its existing content and data as they are. Its cover stays
`/missions/six-names.jpg`.

## Configuration

Values aren't in this repository. Names and instructions are in `.env.example`.

| Variable | Where | Note |
|---|---|---|
| `CHILD_CODE_ENCRYPTION_KEY` | Server only | New. Generate your own, different in every environment. Without it, codes work but can't be viewed again. See `docs/CHILD-CODE-ENCRYPTION.md`. |
| `CHILD_CODE_ENCRYPTION_KEY_PREVIOUS` | Server only | Only during a key rotation. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Server only | Needed before selling gifts. `EMAIL_FROM` needs a verified domain. |
| `NEXT_PUBLIC_SITE_URL` | Server | Gift links are built from it. |
| `WLA_DEV_MAILPIT_URL` | `.env.development.local` only | Local email under `next dev`. Never set it in production. |

Each database generates its own gift code pepper when the migration runs, so there's
nothing to set for that.

### Local setup differs from the committed `supabase/config.toml`

`scripts/browser/local/` needs local Supabase settings that aren't committed:

- API on port `55321` and Mailpit on port `55324`, hard-coded in `driver.mjs`. The
  committed config uses `54321` and `54324`, and `.env.example` shows `55324` for Mailpit.
- `enable_confirmations = true`, because the journeys confirm sign-ups from Mailpit.
- `http://localhost:3000/**` in `additional_redirect_urls`.

Either make those changes in your own copy without committing them, or change the
scripts. `driver.mjs` also expects Google Chrome at its macOS path, and it reads
`.env.development.local`, which you need to create. Stripe keys must be test-mode.

## The public website isn't in this branch

The website (`wla-main`) isn't part of this repository, so its changes aren't here. It
needs `coverAddress` in `src/lib/missions-shared.ts`, which makes relative cover paths
point to the Academy and `mission-covers/...` values point to `VITE_SUPABASE_URL`, plus
the gift hand-off described in D-141. Get those changes separately.

Before production, the website must use the Academy's Supabase project, or uploaded
covers won't load, and `VITE_ACADEMY_URL` must be set, or its relative images and links
point at localhost.

## Before production

1. Add the `/redeem` request limit above.
2. Apply the six migrations to the hosted database.
3. Set the server variables above, keeping a copy of the encryption key in your secret store.
4. Register the Stripe webhook endpoint and test real delivery.
5. Test real Resend delivery from the verified domain.
6. Connect the website to the Academy's Supabase project and set `VITE_ACADEMY_URL`.

## Running the tests

```
npm run typecheck
npm run lint
npm test
bash scripts/run-security-regression.sh
bash scripts/run-gift-regression.sh
bash scripts/run-cover-regression.sh
node scripts/browser/local/journeys-access.mjs
node scripts/browser/local/journeys-gift.mjs
node scripts/browser/local/journeys-cover.mjs
```

The database scripts expect the local stack in the `supabase_db_WLA` container. The
browser journeys create their own `@wla-e2e.test` accounts and remove them afterwards.

## Other known issues

- Existing child codes keep working but can't be viewed until replaced, as designed.
- Academy public pages still list only Six Names (OPEN-25).
- Uploaded covers have no screen-reader description (OPEN-26).
- Covers aren't versioned, so saving one changes the live mission at once (D-146).
- Kit and Mission Media uploads probably fail above 1 MB because of the server action
  limit. This wasn't tested or fixed here.
- Website lint reports existing problems across that project. They aren't part of this
  branch.
