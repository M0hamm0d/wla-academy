import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/features/commerce/checkout";
import { missionLineItem } from "@/features/commerce/checkout";
import type Stripe from "stripe";
import { logError, logWarn } from "@/lib/observability/logger";

export const runtime = "nodejs";

/** Reconcile sessions near Stripe's 24-hour Checkout expiry. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  const creatingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [intents, gifts] = await Promise.all([
    admin.from("checkout_intents").select("id, stripe_session_id").eq("checkout_status", "open").lte("created_at", cutoff).not("stripe_session_id", "is", null).limit(100),
    admin.from("mission_gifts").select("id, stripe_session_id").eq("checkout_status", "open").lte("created_at", cutoff).not("stripe_session_id", "is", null).limit(100),
  ]);
  if (intents.error || gifts.error) {
    logError("checkout_reconcile_lookup_failed", intents.error ?? gifts.error);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  let expired = 0;
  let retained = 0;

  // Recover a process death or uncertain Stripe timeout after the durable
  // reservation but before its session ID was stored. The saved attempt key
  // and parameter snapshot make this an idempotent replay. Do not replay keys
  // nearing Stripe's idempotency retention boundary.
  const [creatingIntents, creatingGifts] = await Promise.all([
    admin.from("checkout_intents").select("id, attempt_key, parent_id, child_id, mission_id, amount_minor, currency, mission_title, mission_description, mission_slug, customer_email, site_origin, created_at")
      .eq("checkout_status", "initializing").lte("created_at", creatingCutoff).gt("created_at", cutoff).not("attempt_key", "is", null).limit(50),
    admin.from("mission_gifts").select("id, attempt_key, purchaser_id, mission_id, amount_minor, currency, mission_title, mission_description, mission_slug, customer_email, site_origin, created_at")
      .eq("checkout_status", "initializing").lte("created_at", creatingCutoff).gt("created_at", cutoff).not("attempt_key", "is", null).limit(50),
  ]);
  if (creatingIntents.error || creatingGifts.error) {
    logError("checkout_reconcile_initializing_lookup_failed", creatingIntents.error ?? creatingGifts.error);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
  const creating = [
    ...(creatingIntents.data ?? []).map((r) => ({ ...r, table: "checkout_intents" as const })),
    ...(creatingGifts.data ?? []).map((r) => ({ ...r, table: "mission_gifts" as const })),
  ];
  for (const row of creating) {
    try {
      if (!row.attempt_key || !row.mission_title || !row.mission_slug || !row.site_origin) continue;
      const line = missionLineItem({ title: row.mission_title, description: row.mission_description, currency: row.currency, price_minor: row.amount_minor });
      const isGift = row.table === "mission_gifts";
      const params: Stripe.Checkout.SessionCreateParams = isGift ? {
        mode: "payment" as const, payment_method_types: ["card" as const], line_items: [line], customer_email: row.customer_email ?? undefined,
        success_url: `${row.site_origin}/gift?purchase=success`, cancel_url: `${row.site_origin}/purchase/${row.mission_slug}?gift=1&cancelled=1`,
        client_reference_id: row.id, metadata: { gift: "1", gift_id: row.id, mission_id: row.mission_id, parent_id: row.purchaser_id ?? "" },
      } : {
        mode: "payment" as const, payment_method_types: ["card" as const], line_items: [line], customer_email: row.customer_email ?? undefined,
        success_url: `${row.site_origin}/academy/my-missions?purchase=success`, cancel_url: `${row.site_origin}/purchase/${row.mission_slug}?cancelled=1`,
        client_reference_id: row.id, metadata: { checkout_intent_id: row.id, child_id: row.child_id, mission_id: row.mission_id, parent_id: row.parent_id },
      };
      const recovered = await stripe().checkout.sessions.create(params, { idempotencyKey: `wla-${isGift ? "gift" : "mission"}-${row.attempt_key}` });
      const { error } = await admin.from(row.table).update({ stripe_session_id: recovered.id, checkout_status: "open" })
        .eq("id", row.id).eq("checkout_status", "initializing");
      if (error) throw error;
      if (recovered.status === "expired") {
        const { error: expireError } = await admin.from(row.table).update({ checkout_status: "expired" }).eq("id", row.id).eq("checkout_status", "open");
        if (expireError) throw expireError;
        expired++;
        continue;
      }
      if (recovered.status === "open") {
        const ended = await stripe().checkout.sessions.expire(recovered.id);
        if (ended.status === "expired") {
          const { error: expireError } = await admin.from(row.table).update({ checkout_status: "expired" }).eq("id", row.id).eq("checkout_status", "open");
          if (expireError) throw expireError;
          expired++;
          continue;
        }
      }
      retained++;
    } catch (error) {
      logWarn("checkout_reconcile_initializing_deferred", { purchaseId: row.id, reason: error instanceof Error ? error.message : "unknown" });
      retained++;
    }
  }
  for (const row of [
    ...(intents.data ?? []).map((r) => ({ ...r, table: "checkout_intents" as const })),
    ...(gifts.data ?? []).map((r) => ({ ...r, table: "mission_gifts" as const })),
  ]) {
    if (!row.stripe_session_id) continue;
    try {
      let session = await stripe().checkout.sessions.retrieve(row.stripe_session_id);
      if (session.status === "open") session = await stripe().checkout.sessions.expire(row.stripe_session_id);
      if (session.status === "expired") {
        const { error } = await admin.from(row.table).update({ checkout_status: "expired" })
          .eq("id", row.id).eq("checkout_status", "open");
        if (error) throw error;
        expired++;
      } else {
        // Completed sessions are left for verified webhook processing.
        retained++;
      }
    } catch (error) {
      // Transient Stripe/database errors leave the purchase active for retry.
      logWarn("checkout_reconcile_item_deferred", { purchaseId: row.id, table: row.table, reason: error instanceof Error ? error.message : "unknown" });
      retained++;
    }
  }
  return NextResponse.json({ checked: expired + retained, expired, retained });
}
