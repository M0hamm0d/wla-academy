import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatPrice } from "@/lib/utils";

const repo = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(repo, p), "utf8");

const checkout = read("src/features/commerce/checkout.ts");
const actions = read("src/features/commerce/actions.ts");
const webhook = read("src/app/api/webhooks/stripe/route.ts");
const commerceSql = read("supabase/migrations/20260925220400_commerce.sql");
const initSql = read("supabase/migrations/20260925220000_init.sql");

// ──────────────────────────────────────────────────── server-side authority ──
describe("the client cannot influence what is charged", () => {
  it("price and currency are read from the mission row", () => {
    expect(checkout).toContain("unit_amount: mission.price_minor");
    expect(checkout).toContain("currency: mission.currency.toLowerCase()");
  });

  it("no price, amount or currency is ever read from the request", () => {
    for (const source of [
      /formData\.get\(["'](price|amount|currency|unit_amount)["']\)/,
      /searchParams\.get\(["'](price|amount|currency)["']\)/,
    ]) {
      expect(checkout).not.toMatch(source);
      expect(actions).not.toMatch(source);
    }
  });

  it("the purchase form submits only a child id", () => {
    const form = read("src/components/commerce/purchase-form.tsx");
    const inputs = form.match(/name="[^"]+"/g) ?? [];
    expect(inputs).toEqual(['name="childId"']);
  });

  it("an unpriced or zero-priced mission cannot be bought", () => {
    expect(checkout).toContain(
      "!mission.price_minor || mission.price_minor <= 0",
    );
  });

  it("a free mission never travels through Stripe", () => {
    // D-10: free access is an entitlement source, not a payment.
    expect(checkout).toContain("if (mission.is_free)");
    expect(checkout).toContain('"free_mission"');
  });

  it("only a published mission is purchasable", () => {
    expect(checkout).toContain('.eq("published", true)');
  });
});

// ─────────────────────────────────────────────────── child-assignment safety ──
describe("child assignment", () => {
  it("ownership is verified before any Stripe call", () => {
    const verifyAt = checkout.indexOf("requireOwnedChild(childId)");
    const stripeAt = checkout.indexOf("stripe().checkout.sessions.create");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(stripeAt);
  });

  it("the intent is recorded server-side, keyed to the verified child", () => {
    expect(checkout).toContain('from("checkout_intents").insert');
    expect(checkout).toContain("child_id: child.id");
  });

  it("the webhook resolves the child from our record, not Stripe metadata", () => {
    // Metadata round-trips through the browser's session; the intent row does
    // not, so it is the authoritative answer to "who was this for".
    expect(webhook).toContain('from("checkout_intents")');
    expect(webhook).toContain('.eq("stripe_session_id", session.id)');
    expect(webhook).toContain("intent.child_id");
    expect(webhook).toContain("session.metadata?.child_id !== intent.child_id");
  });

  it("an unowned child id fails without revealing that it exists", () => {
    expect(actions).toContain("error instanceof AccessError");
    // Same message as an empty submission.
    const accessBranch = actions.slice(
      actions.indexOf("error instanceof AccessError"),
    );
    expect(accessBranch).toContain('Choose who this mission is for."');
  });

  it("checkout_intents is not client-writable", () => {
    const policies = commerceSql
      .split("create policy")
      .slice(1)
      .map((b) => b.slice(0, b.indexOf(";")))
      .filter((b) => b.includes("on checkout_intents"));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain("for select");
    expect(policies[0]).toContain("parent_id = auth.uid()");
  });
});

// ────────────────────────────────────────────────────── webhook verification ──
describe("webhook verification", () => {
  it("rejects a request with no signature", () => {
    expect(webhook).toContain('request.headers.get("stripe-signature")');
    expect(webhook).toContain('{ error: "Missing signature" }');
  });

  it("verifies the signature against the raw body", () => {
    const rawAt = webhook.indexOf("await request.text()");
    const verifyAt = webhook.indexOf("webhooks.constructEvent");
    expect(rawAt).toBeGreaterThan(-1);
    expect(rawAt).toBeLessThan(verifyAt);
    // request.json() would consume and re-serialise the body, breaking it.
    expect(webhook).not.toContain("request.json()");
  });

  it("runs on the Node runtime, which is required for raw-body access", () => {
    expect(webhook).toContain('export const runtime = "nodejs"');
  });

  it("does not leak verification detail on failure", () => {
    expect(webhook).toContain('{ error: "Invalid signature" }');
    expect(webhook).not.toMatch(/error:\s*(err|error)\.message/);
  });

  it("grants nothing for an unpaid session", () => {
    expect(webhook).toContain('session.payment_status !== "paid"');
  });

  it("reconciles the amount and currency Stripe actually collected", () => {
    expect(webhook).toContain("session.amount_total !== intent.amount_minor");
    expect(webhook).toContain("session.currency?.toUpperCase()");
  });
});

// ──────────────────────────────────────────────────────────────── idempotency ──
describe("webhook idempotency", () => {
  it("claims the event by primary key before doing any work", () => {
    const claimAt = webhook.indexOf('from("stripe_events")');
    const grantAt = webhook.indexOf('from("mission_entitlements")');
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(grantAt);
    expect(commerceSql).toContain("id           text primary key");
  });

  it("a duplicate delivery exits 200 without side effects", () => {
    expect(webhook).toContain("received: true, duplicate: true");
  });

  it("the entitlement grant is itself idempotent", () => {
    expect(webhook).toContain('onConflict: "child_id,mission_id"');
    expect(webhook).toContain("ignoreDuplicates: true");
    expect(initSql).toContain("unique (child_id, mission_id)");
  });

  it("releases the claim on failure so a retry can genuinely re-run", () => {
    // Otherwise a transient database error would permanently swallow the event
    // and a paying family would never receive their mission.
    expect(webhook).toContain(
      'from("stripe_events").delete().eq("id", event.id)',
    );
    expect(webhook).toContain("status: 500");
  });

  it("stripe_events is unreachable from any client", () => {
    expect(commerceSql).toContain(
      "alter table stripe_events enable row level security",
    );
    const policies = commerceSql
      .split("create policy")
      .slice(1)
      .filter((b) => b.slice(0, b.indexOf(";")).includes("on stripe_events"));
    expect(policies).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────── entitlement creation path ──
describe("entitlement creation", () => {
  it("only the webhook creates a PAID entitlement", () => {
    // checkout.ts may write an entitlement, but only a free one (D-24).
    // `source: "purchase"` must appear nowhere but the verified webhook.
    expect(webhook).toContain('source: "purchase"');
    for (const file of [
      "src/features/commerce/checkout.ts",
      "src/features/commerce/actions.ts",
      "src/features/commerce/queries.ts",
      "src/app/purchase/[slug]/page.tsx",
    ]) {
      expect(read(file), file).not.toContain('source: "purchase"');
    }
  });

  it("no route or component writes an entitlement of any kind", () => {
    // Writes are confined to the webhook and the free-grant helper.
    const allowed = [
      "src/app/api/webhooks/stripe/route.ts",
      "src/features/commerce/checkout.ts",
    ];
    for (const file of sourceFiles(join(repo, "src"))) {
      const rel = file.slice(repo.length + 1).replaceAll("\\", "/");
      if (allowed.includes(rel)) continue;
      expect(
        readFileSync(file, "utf8"),
        `${rel} writes mission_entitlements`,
      ).not.toMatch(
        /from\("mission_entitlements"\)[\s\S]{0,80}\.(insert|upsert)\(/,
      );
    }
  });

  it("the browser's return from Stripe is not treated as proof of payment", () => {
    const myMissions = read("src/app/(academy)/academy/my-missions/page.tsx");
    // The notice says the mission WILL appear, never that it has.
    expect(myMissions).toContain("Once the payment is confirmed");
    expect(myMissions).not.toMatch(
      /purchase === "complete"[\s\S]{0,400}insert/,
    );
  });

  it("no separate payment or account architecture was introduced", () => {
    // D-10 — entitlements remain the single access concept.
    for (const forbidden of [
      "create table purchases",
      "create table orders",
      "create table subscriptions",
      "create table payment_methods",
    ]) {
      expect(commerceSql).not.toContain(forbidden);
    }
  });

  it("no subscription or recurring billing was added", () => {
    expect(checkout).toContain('mode: "payment"');
    expect(checkout).not.toContain('mode: "subscription"');
    expect(checkout).not.toMatch(/recurring|billing_cycle|trial_period/);
  });
});

// ──────────────────────────────────────────────────────────────────── pricing ──
describe("GBP pricing", () => {
  it("formats from the mission's own currency", () => {
    expect(formatPrice(1250, "GBP")).toBe("£12.50");
    expect(formatPrice(900, "GBP")).toBe("£9.00");
  });

  it("no component hard-codes a currency", () => {
    const form = read("src/components/commerce/purchase-form.tsx");
    expect(form).not.toMatch(/£|GBP/);
  });

  it("no additional currencies were introduced", () => {
    expect(checkout).not.toMatch(/["'](USD|EUR|NGN)["']/i);
  });
});

// ────────────────────────────────────────────────────────── privacy in Stripe ──
describe("privacy", () => {
  it("no child name or id is sent to Stripe in product data", () => {
    const lineItems = checkout.slice(
      checkout.indexOf("line_items:"),
      checkout.indexOf("customer_email"),
    );
    expect(lineItems).not.toContain("child.display_name");
    expect(lineItems).not.toContain("child.id");
  });

  it("analytics gained no payment events", () => {
    // The approved seam is mission_started / mission_completed only.
    const events = read("src/lib/analytics/events.ts");
    expect(events).not.toMatch(/purchase|checkout|payment|revenue/i);
  });
});

// ═══════════════════════════════════════ OPEN-06 / D-24 — free missions ════
describe("free missions", () => {
  it("the browser never decides whether a mission is free", () => {
    // One action for both paths; the client submits only a child id.
    const form = read("src/components/commerce/purchase-form.tsx");
    const inputs = form.match(/name="[^"]+"/g) ?? [];
    expect(inputs).toEqual(['name="childId"']);

    // is_free is read from the mission row, server-side.
    expect(checkout).toContain("if (mission.is_free)");
    expect(actions).not.toContain('formData.get("isFree")');
    expect(actions).not.toContain('formData.get("free")');
  });

  it("free access is verified server-side from the mission row", () => {
    const acquire = checkout.slice(
      checkout.indexOf("export async function acquireMission"),
    );
    const body = acquire.slice(
      0,
      acquire.indexOf("\nasync function grantFreeEntitlement"),
    );
    expect(body).toContain('.eq("published", true)');
    expect(body).toContain("if (mission.is_free)");
    expect(body).toContain("grantFreeEntitlement(child.id, mission.id)");
  });

  it("ownership is verified before a free grant", () => {
    const acquire = checkout.slice(
      checkout.indexOf("export async function acquireMission"),
    );
    const verifyAt = acquire.indexOf("requireOwnedChild(childId)");
    const grantAt = acquire.indexOf("grantFreeEntitlement(");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(grantAt);
  });

  it("a free grant is idempotent", () => {
    const grant = checkout.slice(
      checkout.indexOf("async function grantFreeEntitlement"),
    );
    expect(grant).toContain('onConflict: "child_id,mission_id"');
    expect(grant).toContain("ignoreDuplicates: true");
    // And asking twice short-circuits before granting at all.
    expect(checkout).toContain('return { kind: "owned", childId: child.id };');
  });

  it("a free mission never reaches Stripe", () => {
    // Guarded twice: acquireMission routes away from it, and
    // createCheckoutSession refuses it outright.
    const session = checkout.slice(
      checkout.indexOf("async function createCheckoutSession"),
    );
    expect(session).toContain("if (mission.is_free)");
    expect(session).toContain('"free_mission"');
  });

  it("free entitlements use the shared table, not a parallel architecture", () => {
    // D-10 — the Academy asks whether access is valid, never why.
    const grant = checkout.slice(
      checkout.indexOf("async function grantFreeEntitlement"),
    );
    expect(grant).toContain('from("mission_entitlements")');
    expect(grant).toContain('source: "free"');
  });

  it("the client cannot grant itself a free mission", () => {
    // mission_entitlements has no insert policy, so the grant needs the
    // service role — the same boundary that protects paid entitlements.
    const grant = checkout.slice(
      checkout.indexOf("async function grantFreeEntitlement"),
    );
    expect(grant).toContain("createAdminClient()");
  });

  it("returns the parent to My Missions after a grant", () => {
    expect(actions).toContain('redirect("/academy/my-missions?added=1")');
  });

  it("no mission is hard-coded as the free one", () => {
    const queries = read("src/features/commerce/queries.ts");
    expect(queries).toContain('.eq("is_free", true)');
    const tryFree = read("src/app/(functional)/try-free/page.tsx");
    expect(tryFree).not.toMatch(/six-names|mars-bridge|SixNames|MarsBridge/i);
  });
});

// ════════════════════════════════════ deferred: D-20 refunds, D-21 tax ═════
describe("deferred commerce scope", () => {
  it("no refund or dispute webhook is handled (D-20)", () => {
    for (const forbidden of [
      "charge.refunded",
      "charge.dispute.created",
      "payment_intent.payment_failed",
    ]) {
      expect(webhook).not.toContain(forbidden);
    }
  });

  it("nothing sets entitlement_status to revoked (D-20)", () => {
    for (const file of [
      "src/features/commerce/checkout.ts",
      "src/features/commerce/actions.ts",
      "src/app/api/webhooks/stripe/route.ts",
    ]) {
      expect(read(file)).not.toMatch(/status:\s*["']revoked["']/);
    }
  });

  it("no Stripe Tax or tax ID collection (D-21)", () => {
    expect(checkout).not.toMatch(/automatic_tax|tax_id_collection|tax_rates/);
  });

  it("no resource versioning was introduced (D-19)", () => {
    const pinning = read(
      "supabase/migrations/20260925220300_version_pinning.sql",
    );
    expect(pinning).not.toContain("alter table mission_resources");
  });
});

function sourceFiles(dir: string): string[] {
  const { existsSync, readdirSync, statSync } = fs;
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !full.includes("__tests__")) {
      out.push(full);
    }
  }
  return out;
}

describe("configuration is split by service", () => {
  const read = (p: string) =>
    readFileSync(join(__dirname, "../../../..", p), "utf8");
  const code = (p: string) =>
    read(p)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

  it("a FREE mission grant does not require Stripe credentials", () => {
    /*
     * REGRESSION. `createAdminClient()` read a single schema validating all
     * five variables together, so `grantFreeEntitlement` threw whenever Stripe
     * was unconfigured — a deployment offering only free missions could not
     * grant access at all.
     *
     * `lib/email/send.ts` had already reasoned to the same conclusion in the
     * other direction: "email must not become a hard requirement for payments
     * to work". Payments must equally not gate free access.
     */
    const admin = code("src/lib/supabase/admin.ts");
    expect(admin).toContain("supabaseServerEnv");
    expect(admin).not.toContain("stripeEnv");

    const env = code("src/lib/env.ts");
    const supabaseBlock = env.slice(
      env.indexOf("const supabaseSchema"),
      env.indexOf("const stripeSchema"),
    );
    expect(supabaseBlock).not.toContain("STRIPE");
  });

  it("Stripe credentials are read only where Stripe is involved", () => {
    for (const file of [
      "src/features/commerce/checkout.ts",
      "src/app/api/webhooks/stripe/route.ts",
    ]) {
      expect(code(file)).toContain("stripeEnv");
    }
    // And nowhere else.
    const offenders: string[] = [];
    for (const file of [
      "src/lib/supabase/admin.ts",
      "src/lib/email/send.ts",
      "src/lib/analytics/events.ts",
    ]) {
      if (code(file).includes("stripeEnv")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("webhook failures are logged through the structured logger", () => {
    // OPS-01 — redaction and a stable reference, not bare console.error.
    const hook = code("src/app/api/webhooks/stripe/route.ts");
    expect(hook).toContain("logError");
    expect(hook).toContain("logWarn");
    expect(hook).not.toContain("console.error");
  });
});
