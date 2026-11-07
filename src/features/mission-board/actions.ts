"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { BoardModerationAction } from "@/types/database";
import { resolveAcademyActor } from "@/features/academy/actor";
import { requireAdmin, requireParent } from "@/lib/permissions";
import { logWarn } from "@/lib/observability/logger";
import { shipLedgerQuietly } from "@/features/privacy/ledger";
import { offerFor } from "./board";

/** Offer one Trail entry. A child's offer waits for a parent; a parent's offer is the permission. */
export async function offerToBoardAction(formData: FormData): Promise<void> {
  const evidenceId = String(formData.get("evidenceId") ?? "");
  const missionSlug = String(formData.get("missionSlug") ?? "");
  const actor = await resolveAcademyActor();
  try {
    await offerFor(actor, evidenceId);
  } catch (error) {
    logWarn("board_offer_refused", { reason: error instanceof Error ? error.message.slice(0, 60) : "unknown" });
  }
  revalidatePath(`/academy/missions/${missionSlug}/trail`);
  revalidatePath("/account");
}

export async function permitBoardAction(formData: FormData): Promise<void> {
  const { supabase } = await requireParent();
  const { error } = await supabase.rpc("board_permit", { p_id: String(formData.get("id") ?? ""), p_allow: formData.get("allow") === "yes" });
  if (error) logWarn("board_permit_failed", { reason: error.message.slice(0, 60) });
  // Declining deletes the offer: the deletion ledger records it (D-157).
  else if (formData.get("allow") !== "yes") await shipLedgerQuietly();
  revalidatePath("/account");
}

export async function withdrawBoardAction(formData: FormData): Promise<void> {
  const { supabase } = await requireParent();
  const { error } = await supabase.rpc("board_withdraw", { p_id: String(formData.get("id") ?? "") });
  if (error) logWarn("board_withdraw_failed", { reason: error.message.slice(0, 60) });
  else await shipLedgerQuietly();
  revalidatePath("/account");
  revalidatePath("/academy/mission-board");
}

const MODERATION_ACTIONS: BoardModerationAction[] = ["publish", "reject", "keep_private", "unpublish", "save", "remove"];

/**
 * Moderate one contribution (D-151). Publishing, or saving a published one,
 * needs the moderator's confirmation that the copy identifies nobody; the
 * database refuses without it, whatever this page sends.
 */
export async function moderateBoardAction(formData: FormData): Promise<void> {
  const { supabase } = await requireAdmin();
  const requested = String(formData.get("action") ?? "save") as BoardModerationAction;
  const action = MODERATION_ACTIONS.includes(requested) ? requested : "save";
  const { error } = await supabase.rpc("admin_board_moderate", {
    p_id: String(formData.get("id") ?? ""),
    p_action: action,
    p_text: String(formData.get("text") ?? ""),
    p_curated: formData.get("curated") === "on",
    p_approach: String(formData.get("approach") ?? ""),
    p_anonymity_confirmed: formData.get("anonymityConfirmed") === "yes",
  });
  if (error) logWarn("board_moderate_failed", { reason: error.message.slice(0, 60) });
  else if (action === "remove") await shipLedgerQuietly();
  revalidatePath("/admin/board");
  revalidatePath("/academy/mission-board");
  if (error?.message.includes("anonymity_not_confirmed")) redirect("/admin/board?confirm=1");
}
