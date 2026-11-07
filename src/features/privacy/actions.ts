"use server";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearActiveChild } from "@/features/children/active-child";
import type { FormState } from "@/features/auth/schemas";
import { GIFT_CLAIM_COOKIE, GIFT_CLAIM_COOKIE_PATH } from "@/features/gifts/claim";
import { publicEnv } from "@/lib/env";
import { logError, logWarn } from "@/lib/observability/logger";
import { AccessError, requireAdmin, requireParent } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { HoldSubject } from "@/types/database";
import { blockSignIn, closeParentAccount, retryOpenClosures, runClosure } from "./closure";
import { shipLedgerQuietly } from "./ledger";

/**
 * Is this the account holder? The session says who is signed in; the password,
 * entered again, says the person at the keyboard is them, which is what a
 * verified closure needs (D-148). Checked with a client that keeps no session.
 */
async function passwordMatches(email: string, password: string): Promise<boolean | "limited"> {
  const probe = createSupabaseClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await probe.auth.signInWithPassword({ email, password });
  if (!error) return true;
  if (error.code === "over_request_rate_limit") return "limited";
  return false;
}

/**
 * Close the account: the parent, every child profile, and everything that
 * belongs to them, except what the law requires WLA to keep (D-148).
 */
export async function closeAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let user: Awaited<ReturnType<typeof requireParent>>["user"];
  try {
    ({ user } = await requireParent());
  } catch (error) {
    if (error instanceof AccessError) return { error: "Please sign in again to continue." };
    throw error;
  }

  if (formData.get("understood") !== "yes") {
    return { fieldErrors: { understood: "Tick the box to confirm you understand what will be deleted." } };
  }
  const password = formData.get("password")?.toString() ?? "";
  if (!password || !user.email) {
    return { fieldErrors: { password: "Enter your password to confirm it's you." } };
  }
  const verified = await passwordMatches(user.email, password);
  if (verified === "limited") return { error: "Too many attempts. Please wait a few minutes and try again." };
  if (!verified) return { fieldErrors: { password: "That password isn't right." } };

  let result: Awaited<ReturnType<typeof closeParentAccount>>;
  try {
    result = await closeParentAccount(user.id, "parent");
  } catch (error) {
    logError("account_closure_failed", error);
    return { error: "We couldn't start closing your account. Nothing has been deleted. Please try again." };
  }
  if (result.state === "refused") {
    return {
      error:
        result.reason === "admin_account"
          ? "An administrator's account can't be closed here. Ask another administrator to remove your admin access first."
          : "We couldn't find this account to close it.",
    };
  }

  // Whatever stage it reached, this browser is signed out of an account that
  // no longer works, and holds nothing of it.
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  await clearActiveChild().catch(() => {});
  (await cookies()).delete({ name: GIFT_CLAIM_COOKIE, path: GIFT_CLAIM_COOKIE_PATH });
  revalidatePath("/", "layout");
  // Only a finished closure may be described as one; under a hold the parent is
  // told the records are kept, never that they will go within 30 days.
  redirect(`/account-closed?state=${result.state === "completed" ? "done" : result.state === "held" ? "held" : "pending"}`);
}

// ----------------------------------------------------------------- admin --

/**
 * A verified erasure request made to WLA (by email, for instance): WLA has
 * verified the requester outside the app, and closes the account here. The
 * address typed twice guards against closing the wrong one.
 */
export async function adminCloseAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireAdmin();
  const email = formData.get("email")?.toString().trim().toLowerCase() ?? "";
  const again = formData.get("emailAgain")?.toString().trim().toLowerCase() ?? "";
  if (!email || email !== again) return { error: "Enter the account's email address twice, exactly the same." };
  if (formData.get("verified") !== "yes") {
    return { error: "Confirm that the request has been verified before closing an account." };
  }

  const { data: profile, error } = await createAdminClient()
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    logError("admin_closure_lookup_failed", error);
    return { error: "We couldn't look that account up just now." };
  }
  if (!profile) return { error: "No account has that email address." };

  try {
    const result = await closeParentAccount(profile.id, "admin");
    revalidatePath("/admin/privacy");
    if (result.state === "refused") {
      return { error: result.reason === "admin_account" ? "That is an administrator's account. Remove admin access first." : "That account can't be closed." };
    }
    return {
      notice:
        result.state === "completed"
          ? "The account has been closed and its data deleted."
          : result.state === "held"
            ? "The account is closed to use, but a retention hold stops its data being deleted. Review the hold below."
            : "The account is closed to use. Deleting its data didn't finish; it is listed below and will be retried.",
    };
  } catch (error) {
    logError("admin_closure_failed", error);
    return { error: "We couldn't start closing that account. Nothing has been deleted." };
  }
}

export async function adminRetryClosuresAction(): Promise<void> {
  await requireAdmin();
  try {
    await retryOpenClosures();
  } catch (error) {
    logError("admin_closure_retry_failed", error);
  }
  revalidatePath("/admin/privacy");
}

export async function adminRetryOneClosureAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = formData.get("id")?.toString() ?? "";
  const admin = createAdminClient();
  const { data: open } = await admin.rpc("privacy_open_deletions", {});
  const d = (open ?? []).find((o) => o.id === id);
  if (d) {
    if (d.subject_type === "parent_account") await blockSignIn(admin, d.parent_id, d.id);
    await runClosure(admin, d.id, d.subject_type, d.parent_id);
  }
  revalidatePath("/admin/privacy");
}

export async function adminPlaceHoldAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { supabase } = await requireAdmin();
  const subjectType = formData.get("subjectType")?.toString() as HoldSubject;
  const subjectId = formData.get("subjectId")?.toString().trim() || null;
  const reason = formData.get("reason")?.toString().trim() ?? "";
  const reviewBy = formData.get("reviewBy")?.toString() || null;
  if (!["parent_account", "child_profile", "board_contribution", "security_logs"].includes(subjectType)) {
    return { error: "Choose what the hold covers." };
  }
  if (subjectType !== "security_logs" && !/^[0-9a-f-]{36}$/i.test(subjectId ?? "")) {
    return { error: "Enter the id of the account, child or contribution the hold covers." };
  }
  if (reason.length < 3) return { error: "Give the reason for the hold: it is the documented exception." };
  const { error } = await supabase.rpc("admin_place_hold", {
    p_subject_type: subjectType,
    p_subject_id: subjectType === "security_logs" ? null : subjectId,
    p_reason: reason,
    p_review_by: reviewBy,
  });
  if (error) {
    logWarn("hold_not_placed", { code: error.code ?? "unknown" });
    return { error: "The hold couldn't be placed. A review date must be within a year." };
  }
  // Into the deletion ledger at once, so a restore can't lose it (D-157).
  await shipLedgerQuietly();
  revalidatePath("/admin/privacy");
  return { notice: "Hold placed. It will be listed for review by its date." };
}

export async function adminReviewHoldAction(formData: FormData): Promise<void> {
  const { supabase } = await requireAdmin();
  const { error } = await supabase.rpc("admin_review_hold", {
    p_id: formData.get("id")?.toString() ?? "",
    p_release: formData.get("decision") === "release",
    p_review_by: null,
  });
  if (error) logWarn("hold_review_failed", { code: error.code ?? "unknown" });
  else await shipLedgerQuietly();
  revalidatePath("/admin/privacy");
}
