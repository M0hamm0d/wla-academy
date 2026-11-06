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
  intents: Row[];
} = { mission: null, entitlement: null, intents: [] };
const adminWrites: { table: string; op: string; row: Row }[] = [];
let failIntentInsert = false;
let failIntentUpdate = false;

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
  const filters: Record<string, unknown> = {};
  let inserted: Row | null = null;
  let updated: Row | null = null;
  const result = () => {
    if (table === "missions") return { data: db.mission };
    if (table === "mission_entitlements") return { data: db.entitlement };
    if (table === "checkout_intents") return { data: db.intents };
    return { data: null };
  };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "gte", "order", "limit", "in"]) q[m] = () => q;
  q.eq = (key: string, value: unknown) => { filters[key] = value; return q; };
  q.insert = (row: Row) => { inserted = row; adminWrites.push({ table, op: "insert", row }); return q; };
  q.update = (row: Row) => { updated = row; adminWrites.push({ table, op: "update", row }); return q; };
  q.maybeSingle = async () => {
    if (inserted) {
      if (failIntentInsert) return { data: null, error: { code: "XX", message: "insert failed" } };
      if (db.intents.some((i) => i.checkout_status === "open" || i.checkout_status === "initializing")) return { data: null, error: { code: "23505", message: "conflict" } };
      const attempt = { ...inserted, id: "intent-1", attempt_key: "attempt-1", stripe_session_id: null, created_at: new Date().toISOString() };
      db.intents.push(attempt);
      return { data: attempt, error: null };
    }
    if (table === "checkout_intents" && Object.keys(filters).length) {
      return { data: db.intents.find((i) => Object.entries(filters).every(([k, v]) => i[k] === v)) ?? null, error: null };
    }
    return result();
  };
  q.then = (resolve: (v: unknown) => void) => {
    if (failIntentUpdate && updated && table === "checkout_intents") return resolve({ data: null, error: { message: "update failed" } });
    if (updated && table === "checkout_intents") {
      db.intents.filter((i) => Object.entries(filters).every(([k, v]) => i[k] === v)).forEach((i) => Object.assign(i, updated));
    }
    resolve({ data: null, error: null });
  };
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
      ...query(table),
      upsert: async (row: Row) => {
        adminWrites.push({ table, op: "upsert", row });
        return { error: null };
      },
    }),
  }),
}));

const { acquireMission } = await import("../checkout");
const go = (childId = "child-1") =>
  acquireMission({ childId, missionSlug: "mars-bridge", origin: "https://academy.example" });

beforeEach(() => {
  db.mission = { id: "m-1", slug: "mars-bridge", title: "Mars Bridge", description: null, is_free: false, price_minor: 1200, currency: "GBP" };
  db.entitlement = null;
  db.intents = [];
  adminWrites.length = 0;
  failIntentInsert = false;
  failIntentUpdate = false;
  for (const fn of Object.values(stripeSessions)) fn.mockReset();
  stripeSessions.create.mockResolvedValue({ id: "cs_new", url: "https://checkout.stripe.example/cs_new" });
});

describe("a fresh purchase", () => {
  it("retries a timed-out Stripe create with the same database attempt and idempotency key", async () => {
    stripeSessions.create.mockRejectedValueOnce(new Error("timeout"));
    await expect(go()).rejects.toMatchObject({ reason: "provider" });
    const firstOptions = stripeSessions.create.mock.calls[0][1];
    await go();
    expect(db.intents).toHaveLength(1);
    expect(stripeSessions.create.mock.calls[1][1]).toEqual(firstOptions);
  });

  it("expires an unreturned Stripe session if recording its ID fails, then can recover by retry", async () => {
    failIntentUpdate = true;
    stripeSessions.expire.mockResolvedValue({ status: "expired" });
    await expect(go()).rejects.toMatchObject({ reason: "provider" });
    expect(stripeSessions.expire).toHaveBeenCalledWith("cs_new");
    failIntentUpdate = false;
    stripeSessions.create.mockResolvedValueOnce({ id: "cs_new", url: "https://checkout.stripe.example/cs_new", status: "expired" });
    await expect(go()).rejects.toMatchObject({ reason: "provider" }); // Stripe returns the now-expired idempotent session
    expect(db.intents).toHaveLength(1);
  });

  it("arbitrates simultaneous submits to one DB attempt and one Stripe idempotency identity", async () => {
    const [a, b] = await Promise.all([go(), go()]);
    expect(a).toMatchObject({ kind: "checkout" });
    expect(b).toMatchObject({ kind: "checkout" });
    expect(db.intents).toHaveLength(1);
    expect(stripeSessions.create).toHaveBeenCalledTimes(2);
    expect(stripeSessions.create.mock.calls[0][1]).toEqual(stripeSessions.create.mock.calls[1][1]);
    expect(stripeSessions.create.mock.calls[0][1].idempotencyKey).toBe("wla-mission-attempt-1");
  });

  it("is tied to the authenticated parent and the verified child, recorded before leaving", async () => {
    const r = await go();
    expect(r).toEqual({ kind: "checkout", childId: "child-1", url: "https://checkout.stripe.example/cs_new" });

    const sent = stripeSessions.create.mock.calls[0][0];
    expect(sent.line_items[0].price_data).toMatchObject({ currency: "gbp", unit_amount: 1200 });
    expect(sent.metadata).toEqual({ checkout_intent_id: "intent-1", child_id: "child-1", mission_id: "m-1", parent_id: "parent-1" });
    expect(sent.client_reference_id).toBe("intent-1");
    expect(stripeSessions.create.mock.calls[0][1]).toEqual({ idempotencyKey: "wla-mission-attempt-1" });
    // The return lands on the wording that says the mission WILL appear.
    expect(sent.success_url).toBe("https://academy.example/academy/my-missions?purchase=success");
    expect(sent.cancel_url).toBe("https://academy.example/purchase/mars-bridge?cancelled=1");

    expect(adminWrites).toEqual([
      {
        table: "checkout_intents",
        op: "insert",
        row: expect.objectContaining({ parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", amount_minor: 1200, currency: "GBP", checkout_status: "initializing" }),
      },
      expect.objectContaining({ table: "checkout_intents", op: "update", row: { stripe_session_id: "cs_new", checkout_status: "open" } }),
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
    db.intents = [{ id: "intent-1", attempt_key: "attempt-1", parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", created_at: new Date().toISOString(), checkout_status: "open", stripe_session_id: "cs_paid", amount_minor: 1200, currency: "GBP", mission_title: "Mars Bridge", mission_description: null, mission_slug: "mars-bridge", customer_email: "parent@example.test" }];
    stripeSessions.retrieve.mockResolvedValue({ id: "cs_paid", status: "complete", payment_status: "paid" });
    await expect(go()).rejects.toMatchObject({ reason: "provider" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
    // And still no entitlement from the browser path.
    expect(adminWrites).toHaveLength(0); // prior active attempt is reused
  });

  it("reuses an existing open session instead of expiring it", async () => {
    db.intents = [{ id: "intent-1", attempt_key: "attempt-1", parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", created_at: new Date().toISOString(), checkout_status: "open", stripe_session_id: "cs_open", amount_minor: 1200, currency: "GBP", mission_title: "Mars Bridge", mission_description: null, mission_slug: "mars-bridge", customer_email: "parent@example.test" }];
    stripeSessions.retrieve.mockResolvedValue({ id: "cs_open", status: "open", payment_status: "unpaid", url: "https://checkout.stripe.example/cs_open" });
    const r = await go();
    expect(stripeSessions.expire).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: "checkout", url: "https://checkout.stripe.example/cs_open" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
  });

  it("an expired session is marked and requires a fresh submission", async () => {
    db.intents = [{ id: "intent-1", attempt_key: "attempt-1", parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", created_at: new Date().toISOString(), checkout_status: "open", stripe_session_id: "cs_expired", amount_minor: 1200, currency: "GBP", mission_title: "Mars Bridge", mission_description: null, mission_slug: "mars-bridge", customer_email: "parent@example.test" }];
    stripeSessions.retrieve.mockResolvedValue({ id: "cs_expired", status: "expired", payment_status: "unpaid" });
    await expect(go()).rejects.toMatchObject({ reason: "provider" });
    expect(stripeSessions.expire).not.toHaveBeenCalled();
  });

  it("Stripe unreachable while checking never opens another payable session", async () => {
    db.intents = [{ id: "intent-1", attempt_key: "attempt-1", parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", created_at: new Date().toISOString(), checkout_status: "open", stripe_session_id: "cs_unknown", amount_minor: 1200, currency: "GBP", mission_title: "Mars Bridge", mission_description: null, mission_slug: "mars-bridge", customer_email: "parent@example.test" }];
    stripeSessions.retrieve.mockRejectedValue(new Error("network"));
    await expect(go()).rejects.toMatchObject({ reason: "provider" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
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
  it("fails before contacting Stripe when the pending intent cannot be written", async () => {
    failIntentInsert = true;
    stripeSessions.expire.mockResolvedValue({});
    // Without the intent the webhook would take the money and grant nothing.
    await expect(go()).rejects.toMatchObject({ name: "CheckoutError", reason: "provider" });
    expect(stripeSessions.create).not.toHaveBeenCalled();
  });

  it("still fails closed if Stripe cannot expire it", async () => {
    failIntentInsert = true;
    stripeSessions.expire.mockRejectedValue(new Error("stripe down"));
    await expect(go()).rejects.toMatchObject({ name: "CheckoutError", reason: "provider" });
  });
});
