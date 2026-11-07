# Local browser journeys

Real journeys in headless Chrome against the local Academy (`localhost:3000`), the
local website (`localhost:8080`) and the local Supabase stack. `next dev` must be
running with `WLA_DEV_MAILPIT_URL` set, and Stripe keys must be test-mode.

```
node scripts/browser/local/journeys-access.mjs   # child codes: view, replace, rotate the key
node scripts/browser/local/journeys-gift.mjs     # purchase with consent, inline child, purchaser-held gift codes (D-149, D-152)
node scripts/browser/local/journeys-cover.mjs    # cover upload, display everywhere, sharing, permissions
node scripts/browser/local/journeys-journal.mjs  # Article Settings, review, publish, update, failure, phone width
node scripts/browser/local/journeys-privacy.mjs  # saved work, child removal, account closure, holds, Board anonymity (D-148, D-151)
node scripts/browser/local/journeys-privacy-failures.mjs  # closures that fail or are held: what the parent is told and can reach, Retry, hold review (D-148, D-154)
```

Each creates its own accounts (`e2e-<run>-...@wla-e2e.test`) through the real pages,
confirms them from Mailpit, and removes everything it made at the end. Set `KEEP=1`
to leave them. Nothing reads `.env.staging-qa` or touches hosted services, except
Stripe's test mode. Output is pass/fail only: no codes, tokens or passwords.

`journeys-gift.mjs` pays on Stripe's hosted test page with its published test card.
There is no `stripe listen` here, so it then fetches the real paid session and delivers
the webhook itself, signed with the local secret.

`journeys-privacy.mjs` creates its accounts through the admin API rather than signup, and
puts real objects in the `mission-evidence` bucket so file removal is checked against
Storage itself. `journeys-gift.mjs`'s last step trips the gift-code attempt limit, which
locally applies to the whole machine for 15 minutes; its cleanup removes those attempts.

Database regressions for the same work: `bash scripts/run-gift-regression.sh` and
`bash scripts/run-privacy-regression.sh` (local stack, rolled back).

The acceptance scripts in `../acceptance/` target hosted staging and read QA credentials,
so they weren't run. Their code-button labels were updated for D-143; where a code
already exists, those scripts now also need to confirm the replacement dialog.
