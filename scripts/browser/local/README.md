# Local browser journeys

Real journeys in headless Chrome against the local Academy (`localhost:3000`), the
local website (`localhost:8080`) and the local Supabase stack. `next dev` must be
running with `WLA_DEV_MAILPIT_URL` set, and Stripe keys must be test-mode.

```
node scripts/browser/local/journeys-access.mjs   # child codes: view, replace, rotate the key
node scripts/browser/local/journeys-gift.mjs     # purchase, inline child, gifts by link and by code
node scripts/browser/local/journeys-cover.mjs    # cover upload, display everywhere, sharing, permissions
node scripts/browser/local/journeys-journal.mjs  # Article Settings, review, publish, update, failure, phone width
```

Each creates its own accounts (`e2e-<run>-...@wla-e2e.test`) through the real pages,
confirms them from Mailpit, and removes everything it made at the end. Set `KEEP=1`
to leave them. Nothing reads `.env.staging-qa` or touches hosted services, except
Stripe's test mode. Output is pass/fail only: no codes, tokens or passwords.

`journeys-gift.mjs` pays on Stripe's hosted test page with its published test card.
There is no `stripe listen` here, so it then fetches the real paid session and delivers
the webhook itself, signed with the local secret.

The acceptance scripts in `../acceptance/` target hosted staging and read QA credentials,
so they weren't run. Their code-button labels were updated for D-143; where a code
already exists, those scripts now also need to confirm the replacement dialog.
