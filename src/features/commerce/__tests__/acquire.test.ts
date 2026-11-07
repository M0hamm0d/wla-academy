import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * acquireMission, run — not read. Stripe, the parent session and the database
 * are stubbed; we assert which outcome is chosen and exactly what is sent to
 * Stripe and recorded, for the cases the purchase flow has to get right:
 * already owned, a payment awaiting its webhook, an abandoned open session,
 * and a fresh purchase tied to the authenticated parent.
 */

type Row = Record<string, unknown>;
const db: {
  mission: Row | null;
  entitlement: Row | null;
  intents: { stripe_session_id: string }[];
} = { mission: null, entitlement: null, intents: [] };
const adminWrites: { table: string; op: string; row: Row }[] = [];
let failIntentInsert = false;

const stripeSessions = {
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
};

vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: stripeSessions };
  },
}));
vi.mock("@/lib/env", () => ({ stripeEnv: () => ({ STRIPE_SECRET_KEY: "sk_test_x" }) }));

/** A query builder whose every filter returns itself; terminal reads resolve per table. */
function query(table: string) {
  const result = () => {
    if (table === "missions") return { data: db.mission };
    if (table === "mission_entitlements") return { data: db.entitlement };
    if (table === "checkout_intents") return { data: db.intents };
    return { data: null };
  };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order", "limit"]) q[m] = () => q;
  q.maybeSingle = async () => result();
  q.then = (resolve: (v: unknown) => void) => resolve(result());
  return q;
}

class AccessError extends Error {}
vi.mock("@/lib/permissions", () => ({
  AccessError,
  requireParent: async () => ({ user: { id: "parent-1", email: "parent@example.test" } }),
  requireOwnedChild: async (childId: string) => {
    if (childId !== "child-1") throw new AccessError("not yours");
    return { child: { id: "child-1", display_name: "Amina" }, supabase: { from: query } };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Row) => {
        adminWrites.push({ table, op: "insert", row });
        return { error: failIntentInsert ? { message: "insert failed" } : null };
      },
      upsert: async (row: Row) => {
        adminWrites.push({ table, op: "upsert", row });
        return { error: null };
      },
    }),
  }),
}));

const { acquireMission } = await import("../checkout");
const { consentWording } = await import("../consent");
const CONSENT = { earlySupplyConsentAt: "2026-11-06T10:00:00.000Z", cancellationAckAt: "2026-11-06T10:00:00.000Z", wording: consentWording() };
const go = (childId = "child-1", consent: typeof CONSENT | null = CONSENT) =>
  acquireMission({ childId, missionSlug: "mars-bridge", origin: "https://academy.example", consent });

beforeEach(() => {
  db.mission = { id: "m-1", slug: "mars-bridge", title: "Mars Bridge", description: null, is_free: false, price_minor: 1200, currency: "GBP" };
  db.entitlement = null;
  db.intents = [];
  adminWrites.length = 0;
  failIntentInsert = false;
  for (const fn of Object.values(stripeSessions)) fn.mockReset();
  stripeSessions.create.mockResolvedValue({ id: "cs_new", url: "https://checkout.stripe.example/cs_new" });
});

describe("a fresh purchase", () => {
  it("is tied to the authenticated parent and the verified child, recorded before leaving", async () => {
    const r = await go();
    expect(r).toEqual({ kind: "checkout", childId: "child-1", url: "https://checkout.stripe.example/cs_new" });

    const sent = stripeSessions.create.mock.calls[0][0];
    expect(sent.line_items[0].price_data).toMatchObject({ currency: "gbp", unit_amount: 1200 });
    expect(sent.metadata).toEqual({ child_id: "child-1", mission_id: "m-1", parent_id: "parent-1" });
    // The return lands on the wording that says the mission WILL appear.
    expect(sent.success_url).toBe("https://academy.example/academy/my-missions?purchase=success");
    expect(sent.cancel_url).toBe("https://academy.example/purchase/mars-bridge?cancelled=1");

    expect(adminWrites).toEqual([
      {
        table: "checkout_intents",
        op: "insert",
        row: {
          stripe_session_id: "cs_new", parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", amount_minor: 1200, currency: "GBP",
          // Both checkout statements, with what they said, kept with the order (D-152).
          early_supply_consent_at: CONSENT.earlySupplyConsentAt,
          cancellation_ack_at: CONSENT.cancellationAckAt,
          consent_wording: CONSENT.wording,
        },
      },
    ]);
    // Never an entitlement from here — only the webhook grants a paid one.
    expect(adminWrites.some((w) => w.table === "mission_entitlements")).toBe(false);
  });

  it("offers card only, so a completed Checkout is a paid one (D-113)", async () => {
    await go();
    const sent = stripeSessions.create.mock.calls[0][0];
    expect(sent.payment_method_types).toEqual(["card"]);
    expect(sent.mode).toBe("payment");
    // Nothing that would let Stripe choose methods from the dashboard instead.
    expect(sent).not.toHaveProperty("automatic_payment_methods");
    expect(sent).not.toHaveProperty("payment_method_configuration");
  });

  it("without both checkout statements, nothing reaches Stripe and nothing is recorded (D-152)", async () => {
    await expect(go("child-1", null)).rejects.toMatchObject({ reason: "consent_required" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
    expect(adminWrites).toHaveLength(0);
  });

  it("a free mission needs no consent: nothing is paid for", async () => {
    db.mission = { ...db.mission!, is_free: true, price_minor: null };
    await expect(go("child-1", null)).resolves.toMatchObject({ kind: "granted" });
  });

  it("refuses another family's child before Stripe is touched", async () => {
    await expect(go("child-of-someone-else")).rejects.toBeInstanceOf(AccessError);
    expect(stripeSessions.create).not.toHaveBeenCalled();
    expect(adminWrites).toHaveLength(0);
  });

  it("refuses an unpublished (or missing) mission", async () => {
    db.mission = null;
    await expect(go()).rejects.toMatchObject({ reason: "not_purchasable" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
  });
});

describe("no confusing duplicate access", () => {
  it("already owned: no Checkout, no grant, says so", async () => {
    db.entitlement = { id: "e-1" };
    expect(await go()).toEqual({ kind: "owned", childId: "child-1" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
    expect(adminWrites).toHaveLength(0);
  });

  it("paid but the webhook has not arrived: no second Checkout", async () => {
    db.intents = [{ stripe_session_id: "cs_paid" }];
    stripeSessions.retrieve.mockResolvedValue({ id: "cs_paid", status: "complete", payment_status: "paid" });
    expect(await go()).toEqual({ kind: "processing", childId: "child-1" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
    // And still no entitlement from the browser path.
    expect(adminWrites).toHaveLength(0);
  });

  it("an abandoned session that is still open is expired, so only the new one can be paid", async () => {
    db.intents = [{ stripe_session_id: "cs_open" }];
    stripeSessions.retrieve.mockResolvedValue({ id: "cs_open", status: "open", payment_status: "unpaid" });
    const r = await go();
    expect(stripeSessions.expire).toHaveBeenCalledWith("cs_open");
    expect(r.kind).toBe("checkout");
  });

  it("an expired or cancelled earlier session is left alone and does not block buying", async () => {
    db.intents = [{ stripe_session_id: "cs_expired" }];
    stripeSessions.retrieve.mockResolvedValue({ id: "cs_expired", status: "expired", payment_status: "unpaid" });
    expect((await go()).kind).toBe("checkout");
    expect(stripeSessions.expire).not.toHaveBeenCalled();
  });

  it("Stripe unreachable while checking: the purchase still starts", async () => {
    db.intents = [{ stripe_session_id: "cs_unknown" }];
    stripeSessions.retrieve.mockRejectedValue(new Error("network"));
    expect((await go()).kind).toBe("checkout");
  });
});

describe("free missions", () => {
  it("are granted directly and never reach Stripe", async () => {
    db.mission = { ...db.mission!, is_free: true, price_minor: null };
    expect(await go()).toEqual({ kind: "granted", childId: "child-1" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
    expect(adminWrites[0]).toMatchObject({ table: "mission_entitlements", op: "upsert", row: { child_id: "child-1", source: "free" } });
  });
});

describe("an unrecorded Checkout is never handed to the parent", () => {
  it("expires the session and fails before any payment when the intent cannot be written", async () => {
    failIntentInsert = true;
    stripeSessions.expire.mockResolvedValue({});
    // Without the intent the webhook would take the money and grant nothing.
    await expect(go()).rejects.toMatchObject({ name: "CheckoutError", reason: "provider" });
    expect(stripeSessions.create).toHaveBeenCalledTimes(1);
    expect(stripeSessions.expire).toHaveBeenCalledWith("cs_new");
  });

  it("still fails closed if Stripe cannot expire it", async () => {
    failIntentInsert = true;
    stripeSessions.expire.mockRejectedValue(new Error("stripe down"));
    await expect(go()).rejects.toMatchObject({ name: "CheckoutError", reason: "provider" });
  });
});
