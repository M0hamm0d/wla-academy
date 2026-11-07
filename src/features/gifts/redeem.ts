import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { hashGiftToken, looksLikeGiftToken, newGiftToken } from "./token";

/**
 * Checking a gift code, for the redemption page (D-149).
 *
 * Service role, because no client role can read `mission_gifts`. It acts only
 * on a secret the caller presented (the D-64 pattern: the secret authorises,
 * this reads), and returns only what that holder may see. Nothing here takes an
 * id or an address.
 */
export type CodeCheck =
  | { outcome: "matched"; claim: string }
  | { outcome: "invalid" }
  | { outcome: "rate_limited" };

/**
 * The code form's answer. Wrong, already used, never paid or no such gift all
 * look the same. `client` identifies the network client for the attempt limit;
 * the database stores only an HMAC of it. Throws only if the database can't
 * answer, which is not the same as a wrong code.
 */
export async function confirmGiftCode(code: string, client: string): Promise<CodeCheck> {
  const { token: claim, hash: claimHash } = newGiftToken();
  const { data, error } = await createAdminClient().rpc("confirm_gift_code", {
    p_code: code,
    p_client: client,
    p_claim_hash: claimHash,
  });
  if (error) throw error;
  if (data === "matched") return { outcome: "matched", claim };
  if (data === "rate_limited") return { outcome: "rate_limited" };
  return { outcome: "invalid" };
}

export type ClaimedGift = { missionId: string; missionTitle: string; missionSlug: string };

/** The gift a confirmed claim refers to, or null if it is no longer redeemable. */
export async function readClaimedGift(claim: string | undefined): Promise<ClaimedGift | null> {
  if (!looksLikeGiftToken(claim)) return null;
  const { data } = await createAdminClient()
    .from("mission_gifts")
    .select("mission_id, status, claim_expires_at, missions(title, slug)")
    .eq("claim_hash", hashGiftToken(claim))
    .maybeSingle();
  if (!data || data.status !== "paid") return null;
  if (!data.claim_expires_at || new Date(data.claim_expires_at).getTime() <= Date.now()) return null;
  const mission = data.missions as unknown as { title: string; slug: string } | null;
  if (!mission) return null;
  return { missionId: data.mission_id, missionTitle: mission.title, missionSlug: mission.slug };
}
