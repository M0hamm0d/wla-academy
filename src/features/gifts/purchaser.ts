import "server-only";

import { CodeCopyError, CodeKeyError, keysFromEnv, openCode } from "@/features/child-auth/code-crypto";
import { logWarn } from "@/lib/observability/logger";
import { requireParent } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GiftStatus } from "@/types/database";
import { formatGiftCode } from "./schemas";

/**
 * THE PURCHASER'S GIFTS (D-149). The purchaser receives each gift's code here
 * (as well as in their confirmation email) and shares it however they choose.
 *
 * Service role, because no client role can read `mission_gifts`; always scoped
 * to the signed-in parent's own id, which comes from `requireParent`, never from
 * the browser. The encrypted copy is opened here and only the code leaves.
 * Nothing about who redeemed a gift is returned: only that, and when.
 */
export type PurchasedGift = {
  id: string;
  missionTitle: string;
  missionSlug: string;
  status: GiftStatus;
  createdAt: string;
  paidAt: string | null;
  redeemedAt: string | null;
  /** The code to share, when it can be shown. */
  code: string | null;
  /** Why it can't be, when it can't: the purchaser can get a new one. */
  codeUnavailable: "no_copy" | "unreadable" | null;
};

export async function listPurchasedGifts(): Promise<PurchasedGift[]> {
  const { user } = await requireParent();
  const { data, error } = await createAdminClient().rpc("purchaser_gifts", { p_purchaser_id: user.id });
  if (error) throw error;
  const keys = keysFromEnv();
  return (data ?? []).map((g) => {
    let code: string | null = null;
    let codeUnavailable: PurchasedGift["codeUnavailable"] = null;
    if (g.status === "paid") {
      if (!g.code_ciphertext) {
        codeUnavailable = "no_copy";
      } else {
        try {
          code = formatGiftCode(openCode(g.code_ciphertext, { giftId: g.id }, keys));
        } catch (e) {
          if (!(e instanceof CodeCopyError) && !(e instanceof CodeKeyError)) throw e;
          logWarn("gift_code_copy_unreadable", { giftId: g.id });
          codeUnavailable = "unreadable";
        }
      }
    }
    return {
      id: g.id,
      missionTitle: g.mission_title,
      missionSlug: g.mission_slug,
      status: g.status,
      createdAt: g.created_at,
      paidAt: g.paid_at,
      redeemedAt: g.redeemed_at,
      code,
      codeUnavailable,
    };
  });
}
