import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { retryOpenClosures } from "@/features/privacy/closure";
import { logError, logInfo } from "@/lib/observability/logger";

/**
 * THE SCHEDULED FOLLOW-UP FOR CLOSURES (D-148).
 *
 * The retention periods run inside the database (pg_cron, privacy_retention_run)
 * and need nothing from here. What only the server can do — removing stored
 * files through the Storage API and deleting an auth user — is retried here for
 * any closure that didn't finish, followed by a sweep for evidence files whose
 * child no longer exists.
 *
 * Call it on a schedule (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`;
 * any scheduler can). Without CRON_SECRET it refuses everything: an open
 * endpoint that deletes things is not acceptable. Counts only in the answer.
 */
export const runtime = "nodejs";

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  try {
    const result = await retryOpenClosures();
    logInfo("closure_retry_ran", result);
    return NextResponse.json(result);
  } catch (error) {
    logError("closure_retry_failed", error);
    return NextResponse.json({ error: "Retry failed" }, { status: 500 });
  }
}
