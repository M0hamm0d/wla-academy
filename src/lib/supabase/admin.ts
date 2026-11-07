import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseServerEnv } from "@/lib/env";
import type { Database } from "@/types/database";
import { boundedFetch } from "./fetch";

/**
 * Service-role client — BYPASSES RLS.
 *
 * Tech Spec §47: never import this from client code. The `server-only` guard
 * above turns any such import into a build error.
 *
 * Legitimate uses are narrow:
 *   - the Stripe webhook creating an entitlement for a not-yet-signed-in user
 *   - granting a FREE mission, which has no session to act on either
 *   - gift purchase and redemption (D-140, D-149): recording a gift before
 *     Checkout, activating it from the verified webhook, keeping and opening the
 *     purchaser's encrypted copy of its code (after requireParent; the purchaser
 *     is re-asserted in the database), and turning a code-confirmed claim into
 *     a child's entitlement
 *   - account closure and child-profile deletion (D-148): removing the family's
 *     stored files through the Storage API and deleting the auth user, after
 *     the parent was verified (password re-entered) or WLA verified an erasure
 *     request; the database records each step and re-asserts ownership
 *   - signing a Mission Kit file a child session was authorised for (D-64)
 *   - storing and reading the encrypted copy of a child's code (D-143), after
 *     requireOwnedChild; both functions re-assert the parent themselves
 *   - signing a Journal image a private preview link was authorised for
 *     (D-134, journal_preview_media_path decides; the route only signs)
 *   - the mission engine store (features/mission-engine/store.ts, D-80):
 *     loading and saving a run AFTER the parent permission chain or the
 *     token-derived child lookup has authorised it. State writes are
 *     service-role only, so no browser can write a run directly.
 *
 * It reads the SUPABASE env only. It used to read a combined schema, which
 * made a free mission grant impossible whenever Stripe was unconfigured.
 *
 * It must never be used to sidestep an access check that lib/permissions
 * should be making. If you reach for it inside a request handler serving a
 * logged-in parent, that is almost certainly the wrong tool.
 */
export function createAdminClient() {
  const env = supabaseServerEnv();
  return createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: boundedFetch },
    },
  );
}
