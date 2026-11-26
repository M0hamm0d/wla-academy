import "server-only";

import { AccessError, requireOwnedChild, requireParent } from "@/lib/permissions";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { openCode, sealCode } from "./code-crypto";


export async function issueChildAccessCode(
  childId: string,
): Promise<{ code: string; viewable: boolean } | { error: "not_owned" | "failed" }> {
  let supabase;
  try {
    ({ supabase } = await requireOwnedChild(childId));
  } catch {
    return { error: "not_owned" };
  }

  const { data, error } = await supabase.rpc("issue_child_access_code", {
    p_child_id: childId,
  });
  const issued = data?.[0];

  if (error || !issued) {
    logWarn("child_code_generate_failed", { childId, reason: error?.message });
    return { error: "failed" };
  }

  return { code: issued.code, viewable: await storeCopy(childId, issued.credential_id, issued.code) };
}

async function storeCopy(childId: string, credentialId: string, code: string): Promise<boolean> {
  try {
    const { user } = await requireParent();
    const { data, error } = await createAdminClient().rpc("store_child_code_copy", {
      p_credential_id: credentialId,
      p_child_id: childId,
      p_parent_id: user.id,
      p_ciphertext: sealCode(code, { childId, credentialId }),
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (error) {
    // The name only: a key error never holds the key, but stay in that habit.
    logWarn("child_code_copy_not_stored", { childId, reason: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

export type RevealResult =
  | { code: string }
  | { error: "not_owned" | "no_copy" | "unreadable" | "failed" };

/**
 * The active code, for the signed-in parent who owns this child. Service role,
 * because no client role may read the copy; it runs only after requireOwnedChild
 * and read_child_code_copy re-asserts the parent itself. Admins have no way here:
 * requireOwnedChild is about the signed-in user's own children.
 */
export async function revealChildAccessCode(childId: string): Promise<RevealResult> {
  let parentId: string;
  try {
    const { user } = await requireParent();
    parentId = user.id;
    await requireOwnedChild(childId);
  } catch (error) {
    if (error instanceof AccessError) return { error: "not_owned" };
    return { error: "failed" };
  }

  const { data, error } = await createAdminClient().rpc("read_child_code_copy", {
    p_child_id: childId,
    p_parent_id: parentId,
  });
  if (error) {
    logWarn("child_code_view_failed", { childId, reason: error.message });
    return { error: "failed" };
  }
  const copy = data?.[0];
  if (!copy) return { error: "no_copy" };

  try {
    const code = openCode(copy.ciphertext, { childId, credentialId: copy.credential_id });
    logInfo("child_code_viewed", { childId, credentialId: copy.credential_id });
    return { code };
  } catch (e) {
    logWarn("child_code_copy_unreadable", { childId, reason: e instanceof Error ? e.name : "unknown" });
    return { error: "unreadable" };
  }
}
