import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { shipLedger } from "@/features/privacy/ledger";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Shipping-only operational endpoint. It never invokes closure processing. */
export async function POST(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  try {
    const result = await shipLedger(createAdminClient());
    if (result.state !== "configured") return NextResponse.json({ error: "Privacy ledger is not configured" }, { status: 503 });
    return NextResponse.json({ shipped: result.shipped });
  } catch (error) {
    logError("deletion_ledger_ship_failed", error);
    return NextResponse.json({ error: "Ledger shipping failed" }, { status: 503 });
  }
}
