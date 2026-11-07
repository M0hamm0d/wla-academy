"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { acquireMission, CheckoutError } from "./checkout";
import { AccessError } from "@/lib/permissions";
import { setActiveChild } from "@/features/children/active-child";
import type { FormState } from "@/features/auth/schemas";
import { logError } from "@/lib/observability/logger";
import { siteUrl } from "@/lib/env";
import { consentFromForm } from "./consent";

/**
 * Acquire a mission for a child.
 *
 * ONE action for free and paid. The browser submits a mission and a child and
 * nothing else — it does not say, and cannot say, how the mission should be
 * acquired. The server reads `is_free` from the mission row and routes
 * accordingly:
 *
 *   free  → entitlement granted directly, back to My Missions
 *   owned → nothing to do; back to My Missions, which says so
 *   paid  → Stripe Checkout, entitlement created by the verified webhook
 *           (or, if an earlier payment for it is awaiting the webhook, no
 *           second Checkout — back to My Missions to wait for it)
 *
 * The child is verified against the authenticated parent before either path
 * runs (`requireOwnedChild`), so a submitted id belonging to another family
 * reaches neither Stripe nor a free grant.
 */
export async function acquireMissionAction(
  missionSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const childId = formData.get("childId")?.toString();
  if (!childId) {
    return { error: "Choose who this mission is for." };
  }

  let result: Awaited<ReturnType<typeof acquireMission>>;
  try {
    result = await acquireMission({
      childId,
      missionSlug,
      origin: siteUrl(),
      consent: consentFromForm(formData),
    });
  } catch (error) {
    if (error instanceof AccessError) {
      // Same message whichever way it failed — do not confirm whether some
      // other family's child id exists.
      return { error: "Choose who this mission is for." };
    }
    if (error instanceof CheckoutError) {
      return error.reason === "consent_required"
        ? { fieldErrors: { consent: error.message } }
        : { error: error.message };
    }
    logError("acquire_mission_failed", error, { missionSlug });
    return { error: "We couldn't add that mission. Please try again." };
  }

  /*
   * My Missions shows the ACTIVE child's collection, so make it the child the
   * mission is for — otherwise a parent who bought for one child while another
   * was selected comes back to a page where the mission never appears.
   * `setActiveChild` re-verifies ownership; the cookie carries no authority.
   */
  await setActiveChild(result.childId).catch(() => {});
  revalidatePath("/academy", "layout");

  // Outside the try: redirect() throws by design.
  if (result.kind === "granted") {
    redirect("/academy/my-missions?added=1");
  }
  if (result.kind === "owned") {
    redirect("/academy/my-missions?owned=1");
  }
  if (result.kind === "processing") {
    // Paid already; the webhook has not confirmed it yet. Same wording as the
    // return from Stripe — it WILL appear, not that it has.
    redirect("/academy/my-missions?purchase=success");
  }

  redirect(result.url);
}
