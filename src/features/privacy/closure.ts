import "server-only";

import { logError, logWarn } from "@/lib/observability/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureRequestLedgered, shipLedger } from "./ledger";

/**
 * ACCOUNT CLOSURE AND CHILD-PROFILE DELETION (D-148).
 *
 * The database records each request (privacy_deletions) and does everything it
 * can do in one transaction; this file does the two things only the server can:
 *
 *   - removing stored files through the Storage API. A row deleted from
 *     storage.objects would leave the stored bytes behind, so a file is only
 *     ticked off once the API has removed it;
 *   - deleting a parent's auth user, which takes the profile with it.
 *
 * Before anything is deleted, the request must be in the deletion ledger
 * outside the database, where one is configured (ledger.ts, D-157): otherwise a
 * restore of an older backup could bring the family back with no record that
 * they had asked to go.
 *
 * Every step can be repeated, so a failure part-way is recorded with an error
 * code (never content) and picked up again: by the next attempt, the scheduled
 * retry, or an administrator. Nothing here decides who may close what: the
 * caller verified the parent (or WLA verified an erasure request), and the
 * database re-asserts that the child belongs to that parent.
 *
 * Service role throughout, because these are deletions no client role is
 * allowed to make (lib/supabase/admin.ts).
 */
type Admin = ReturnType<typeof createAdminClient>;

export type ClosureResult =
  | { state: "completed"; deletionId: string }
  /** Recorded and stopped from being used; finishing is under way or retrying. */
  | { state: "pending"; deletionId: string; step: string }
  /** A lawful hold: nothing more is deleted until it is released. */
  | { state: "held"; deletionId: string }
  | { state: "refused"; reason: "not_found" | "admin_account" | "invalid" };

const REMOVE_BATCH = 100;
/** About 100 years: GoTrue's way of saying "never", while the closure finishes. */
const BAN_FOR = "876000h";

export async function closeParentAccount(parentId: string, requestedBy: "parent" | "admin"): Promise<ClosureResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("privacy_begin_closure", {
    p_subject_type: "parent_account",
    p_subject_id: parentId,
    p_parent_id: parentId,
    p_requested_by: requestedBy,
  });
  if (error) throw error;
  const begun = data?.[0];
  if (!begun || begun.outcome !== "begun" || !begun.deletion_id) {
    return { state: "refused", reason: (begun?.outcome as "not_found" | "admin_account" | "invalid") ?? "invalid" };
  }

  // The account stops working now, whatever happens next: nobody can sign in
  // to it while it is being deleted.
  await blockSignIn(admin, parentId, begun.deletion_id);

  if (begun.status === "held") return { state: "held", deletionId: begun.deletion_id };
  return runClosure(admin, begun.deletion_id, "parent_account", parentId);
}

export async function deleteChildProfile(parentId: string, childId: string, requestedBy: "parent" | "admin"): Promise<ClosureResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("privacy_begin_closure", {
    p_subject_type: "child_profile",
    p_subject_id: childId,
    p_parent_id: parentId,
    p_requested_by: requestedBy,
  });
  if (error) throw error;
  const begun = data?.[0];
  if (!begun || begun.outcome !== "begun" || !begun.deletion_id) {
    return { state: "refused", reason: (begun?.outcome as "not_found" | "admin_account" | "invalid") ?? "invalid" };
  }
  if (begun.status === "held") return { state: "held", deletionId: begun.deletion_id };
  return runClosure(admin, begun.deletion_id, "child_profile", parentId);
}

/**
 * Stop a closing account being used. Idempotent; a user already deleted (404)
 * is fine. Repeated on every retry, because after a restore (D-157) the auth
 * user comes back unblocked.
 */
export async function blockSignIn(admin: Admin, parentId: string, deletionId: string): Promise<void> {
  try {
    const { error } = await admin.auth.admin.updateUserById(parentId, { ban_duration: BAN_FOR });
    if (error && error.status !== 404) logWarn("closure_ban_failed", { deletionId, status: error.status ?? 0 });
  } catch (error) {
    logError("closure_ban_failed", error, { deletionId });
  }
}

/**
 * Take a request as far as it will go. Safe to call again at any point: the
 * database knows which step it reached.
 */
export async function runClosure(
  admin: Admin,
  deletionId: string,
  subject: "parent_account" | "child_profile",
  parentId: string,
  depth = 0,
): Promise<ClosureResult> {
  let step = "ledger";
  try {
    if (depth === 0) {
      const ledgered = await ensureRequestLedgered(admin, deletionId);
      if (!ledgered.ok) {
        await recordFailure(admin, deletionId, "ledger", ledgered.code);
        return { state: "pending", deletionId, step: "ledger" };
      }
    }

    step = "files";
    const files = await removeListedFiles(admin, deletionId);
    if (!files.ok) {
      await recordFailure(admin, deletionId, "files", files.error);
      return { state: "pending", deletionId, step: "files" };
    }

    step = "data";
    const { data: finished, error: finishError } = await admin.rpc("privacy_finish_closure", { p_deletion: deletionId });
    if (finishError) throw finishError;
    if (finished === "held") return { state: "held", deletionId };
    if (finished === "files_pending") {
      // New files were listed (an upload landed meanwhile): one more pass.
      const again = await removeListedFiles(admin, deletionId);
      if (!again.ok) {
        await recordFailure(admin, deletionId, "files", again.error);
        return { state: "pending", deletionId, step: "files" };
      }
      // Bounded: a file that keeps reappearing is a failure to look at, not a loop.
      if (depth >= 2) {
        await recordFailure(admin, deletionId, "files", "files_reappearing");
        return { state: "pending", deletionId, step: "files" };
      }
      return runClosure(admin, deletionId, subject, parentId, depth + 1);
    }
    if (finished === "completed") return { state: "completed", deletionId };
    if (finished !== "data_deleted") {
      await recordFailure(admin, deletionId, "data", `unexpected_${String(finished)}`);
      return { state: "pending", deletionId, step: "data" };
    }

    // A parent's account: the auth user, and with it the profile.
    step = "account";
    const { error: deleteError } = await admin.auth.admin.deleteUser(parentId);
    if (deleteError && deleteError.status !== 404) {
      await recordFailure(admin, deletionId, "account", `auth_${deleteError.status ?? "error"}`);
      return { state: "pending", deletionId, step: "account" };
    }
    const { data: done, error: completeError } = await admin.rpc("privacy_complete_closure", { p_deletion: deletionId });
    if (completeError) throw completeError;
    if (done !== "completed") {
      await recordFailure(admin, deletionId, "account", `not_complete_${String(done)}`);
      return { state: "pending", deletionId, step: "account" };
    }
    return { state: "completed", deletionId };
  } catch (error) {
    logError("closure_step_failed", error, { deletionId, step });
    await recordFailure(admin, deletionId, step, errorCode(error));
    return { state: "pending", deletionId, step };
  }
}

/** Remove every file the request listed, a batch per bucket at a time. */
async function removeListedFiles(admin: Admin, deletionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: files, error } = await admin.rpc("privacy_pending_files", { p_deletion: deletionId });
  if (error) return { ok: false, error: errorCode(error) };
  const byBucket = new Map<string, string[]>();
  for (const f of files ?? []) byBucket.set(f.bucket, [...(byBucket.get(f.bucket) ?? []), f.path]);

  let failed: string | null = null;
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      const batch = paths.slice(i, i + REMOVE_BATCH);
      const { error: removeError } = await admin.storage.from(bucket).remove(batch);
      // Storage answers success for a path that holds no object, which is the
      // right outcome: nothing of it remains.
      const { error: recordError } = await admin.rpc("privacy_record_files", {
        p_deletion: deletionId,
        p_bucket: bucket,
        p_removed: removeError ? [] : batch,
        p_failed: removeError ? batch : [],
        p_error: removeError ? `storage_${removeError.name ?? "error"}`.slice(0, 120) : null,
      });
      if (removeError) failed = `storage_${removeError.name ?? "error"}`;
      if (recordError) failed = errorCode(recordError);
    }
  }
  return failed ? { ok: false, error: failed } : { ok: true };
}

async function recordFailure(admin: Admin, deletionId: string, step: string, code: string): Promise<void> {
  const { error } = await admin.rpc("privacy_record_failure", { p_deletion: deletionId, p_step: step, p_error: code.slice(0, 120) });
  if (error) logError("closure_failure_unrecorded", error, { deletionId, step });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; status?: unknown; name?: unknown };
    if (typeof e.code === "string") return `db_${e.code}`;
    if (typeof e.status === "number") return `http_${e.status}`;
    if (typeof e.name === "string") return e.name.slice(0, 60);
  }
  return "unknown";
}

/**
 * The scheduled follow-up: every open request that isn't held, taken as far as
 * it will go; then files left in the evidence bucket by anything outside this
 * process (or restored from a backup) whose child no longer exists.
 */
export async function retryOpenClosures(): Promise<{ attempted: number; completed: number; orphanFilesRemoved: number; ledgerShipped: number }> {
  const admin = createAdminClient();
  // Anything waiting for the ledger (a hold, a removal) goes first.
  let ledgerShipped = 0;
  try {
    ledgerShipped = (await shipLedger(admin)).shipped;
  } catch (error) {
    logError("deletion_ledger_ship_failed", error);
  }
  const { data: open, error } = await admin.rpc("privacy_open_deletions", {});
  if (error) throw error;
  let completed = 0;
  for (const d of open ?? []) {
    if (d.subject_type === "parent_account") await blockSignIn(admin, d.parent_id, d.id);
    const result = await runClosure(admin, d.id, d.subject_type, d.parent_id);
    if (result.state === "completed") completed++;
  }
  return { attempted: (open ?? []).length, completed, orphanFilesRemoved: await sweepOrphanFiles(admin), ledgerShipped };
}

async function sweepOrphanFiles(admin: Admin): Promise<number> {
  const { data: orphans, error } = await admin.rpc("privacy_orphan_files", { p_limit: 500 });
  if (error) {
    logWarn("orphan_sweep_unavailable", { code: errorCode(error) });
    return 0;
  }
  const paths = (orphans ?? []).filter((o) => o.bucket === "mission-evidence").map((o) => o.path);
  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH);
    const { error: removeError } = await admin.storage.from("mission-evidence").remove(batch);
    if (removeError) logWarn("orphan_sweep_failed", { count: batch.length });
    else removed += batch.length;
  }
  return removed;
}
