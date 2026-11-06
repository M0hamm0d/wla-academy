import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Stripe webhook, run — not read. Signature verification is stubbed and
 * the database is a small in-memory model that behaves the way Postgres does
 * where it matters here: the event ledger's primary key rejects a second
 * claim with 23505, and the entitlement upsert is ON CONFLICT DO NOTHING ...
 * RETURNING, so a second grant returns no row. Each failure can be switched
 * on to show what the route does when the database is not there.
 *
 * What must hold (D-23, D-110, D-112):
 *   - only a unique violation is a duplicate; any other claim error is a 500;
 *   - a failed attempt is retried, and the retry grants;
 *   - a duplicate after success changes nothing and sends no second email;
 *   - a duplicate whose earlier attempt never granted is reconciled;
 *   - one child, one mission, one entitlement, whatever is delivered.
 */

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string };

const db: {
  ledger: Set<string>;
  intents: Map<string, Row>;
  entitlements: Row[];
  claimError: DbError | null;
  releaseError: DbError | null;
  intentError: DbError | null;
  entitlementError: DbError | null;
  releases: string[];
  gifts: Row[];
  giftError: DbError | null;
} = {
  ledger: new Set(),
  intents: new Map(),
  entitlements: [],
  claimError: null,
  releaseError: null,
  intentError: null,
  entitlementError: null,
  releases: [],
  gifts: [],
  giftError: null,
};

vi.mock("@/lib/env", () => ({
  stripeEnv: () => ({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }),
  siteUrl: () => "https://academy.test",
}));
vi.mock("@/features/commerce/checkout", () => ({
  stripe: () => ({
    webhooks: {
      constructEvent: (payload: string, signature: string) => {
        if (signature !== "t=1,v1=valid") throw new Error("No signatures found");
        return JSON.parse(payload);
      },
    },
  }),
}));
vi.mock("@/lib/email/send", () => ({
  sendMissionAccessEmail: vi.fn(async () => ({ sent: false, reason: "not_configured" })),
  sendGiftEmail: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(() => "ref"),
  logWarn: vi.fn(),
}));

/** Rows the access-email lookup reads, so a grant really reaches the email. */
const lookups: Record<string, Row> = {
  child_profiles: { display_name: "Amina", parent_id: "parent-1" },
  missions: { title: "Six Names", slug: "six-names" },
  profiles: { email: "parent@example.test" },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let deleting = false;
      const q: Record<string, unknown> = {};

      q.insert = async (row: Row) => {
        if (table !== "stripe_events") return { error: null };
        if (db.claimError) return { error: db.claimError };
        if (db.ledger.has(row.id as string)) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        db.ledger.add(row.id as string);
        return { error: null };
      };
      q.select = () => q;
      let patch: Row | null = null;
      q.update = (p: Row) => {
        patch = p;
        return q;
      };
      q.is = () => q;
      q.delete = () => {
        deleting = true;
        return q;
      };
      q.eq = (col: string, value: unknown) => {
        filters[col] = value;
        return q;
      };
      // `await admin.from("stripe_events").delete().eq(...)` — the release.
      q.then = (resolve: (v: unknown) => void) => {
        if (patch && table === "mission_gifts") {
          const rows = db.gifts.filter((g) => Object.entries(filters).every(([k, v]) => g[k] === v));
          rows.forEach((g) => Object.assign(g, patch));
          return resolve({ data: rows, error: null });
        }
        if (!deleting) return resolve({ data: null, error: null });
        db.releases.push(filters.id as string);
        if (db.releaseError) return resolve({ error: db.releaseError });
        db.ledger.delete(filters.id as string);
        return resolve({ error: null });
      };
      q.maybeSingle = async () => {
        if (table === "checkout_intents") {
          if (db.intentError) return { data: null, error: db.intentError };
          return { data: db.intents.get(filters.stripe_session_id as string) ?? null, error: null };
        }
        if (table === "mission_gifts") {
          if (db.giftError) return { data: null, error: db.giftError };
          return { data: db.gifts.find((g) => g.stripe_session_id === filters.stripe_session_id) ?? null, error: null };
        }
        if (table === "mission_entitlements") {
          const row = db.entitlements.find(
            (e) => e.child_id === filters.child_id && e.mission_id === filters.mission_id,
          );
          return { data: row ?? null, error: null };
        }
        return { data: lookups[table] ?? null, error: null };
      };
      // Awaitable directly or via .select(), as supabase-js is.
      q.upsert = (row: Row) => {
        const run = () => {
          if (db.entitlementError) return { data: null, error: db.entitlementError };
          const exists = db.entitlements.some(
            (e) => e.child_id === row.child_id && e.mission_id === row.mission_id,
          );
          if (exists) return { data: [], error: null };
          db.entitlements.push(row);
          return { data: [{ id: `ent-${db.entitlements.length}` }], error: null };
        };
        return {
          select: async () => run(),
          then: (resolve: (v: unknown) => void) => resolve({ ...run(), data: null }),
        };
      };
      return q;
    },
  }),
}));

const { POST } = await import("../route");
const { sendMissionAccessEmail } = await import("@/lib/email/send");
const { logError } = await import("@/lib/observability/logger");

const INTENT = { id: "intent-1", parent_id: "parent-1", child_id: "child-1", mission_id: "m-1", amount_minor: 1200, currency: "GBP", checkout_status: "open" };

function deliver({
  id = "evt_1",
  type = "checkout.session.completed",
  session = {},
  signature = "t=1,v1=valid",
}: { id?: string; type?: string; session?: Row; signature?: string } = {}) {
  const event = {
    id,
    type,
    data: {
      object: {
        id: "cs_1",
        mode: "payment",
        client_reference_id: db.gifts.length ? "gift-1" : "intent-1",
        payment_status: "paid",
        amount_total: 1200,
        currency: "gbp",
        payment_intent: "pi_1",
        metadata: db.gifts.length
          ? { gift: "1", gift_id: "gift-1", mission_id: "mission-1", parent_id: "parent-1" }
          : { checkout_intent_id: "intent-1", mission_id: "m-1", child_id: "child-1", parent_id: "parent-1" },
        ...session,
      },
    },
  };
  return POST(
    new Request("https://academy.example/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: JSON.stringify(event),
    }),
  );
}

beforeEach(() => {
  db.ledger = new Set();
  db.intents = new Map([["cs_1", INTENT]]);
  db.entitlements = [];
  db.gifts = [];
  db.giftError = null;
  db.claimError = null;
  db.releaseError = null;
  db.intentError = null;
  db.entitlementError = null;
  db.releases = [];
  vi.mocked(sendMissionAccessEmail).mockClear();
  vi.mocked(logError).mockClear();
});

// ─────────────────────────────────────────────────────────── the event claim ──
describe("claiming the event (D-112)", () => {
  it("a successful first delivery claims, grants exactly that child, and emails once", async () => {
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db.ledger.has("evt_1")).toBe(true);
    expect(db.entitlements).toEqual([
      expect.objectContaining({ child_id: "child-1", mission_id: "m-1", source: "purchase", status: "active" }),
    ]);
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
  });

  it("a transient claim failure is a retryable 500, not a duplicate", async () => {
    // No code: what supabase-js returns when the request never reached
    // Postgres. 08006 (connection failure) and 57014 (statement timeout)
    // must be treated the same way.
    for (const claimError of [
      { message: "TypeError: fetch failed" },
      { code: "08006", message: "connection failure" },
      { code: "57014", message: "canceling statement due to statement timeout" },
    ]) {
      db.claimError = claimError;
      const res = await deliver();
      expect(res.status).toBe(500);
      expect(await res.json()).not.toMatchObject({ duplicate: true });
    }
    expect(db.entitlements).toEqual([]);
    expect(sendMissionAccessEmail).not.toHaveBeenCalled();
    // Nothing was claimed, so there is nothing to release.
    expect(db.releases).toEqual([]);
    expect(logError).toHaveBeenCalledWith("stripe_event_claim_failed", expect.anything(), { eventId: "evt_1" });
  });

  it("the retry after a transient claim failure grants", async () => {
    db.claimError = { message: "TypeError: fetch failed" };
    expect((await deliver()).status).toBe(500);
    db.claimError = null;
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(db.entitlements).toHaveLength(1);
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
  });

  it("a genuine duplicate after success is acknowledged and changes nothing", async () => {
    await deliver();
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(db.entitlements).toHaveLength(1);
    // No second access email for the same purchase.
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
    // The duplicate never touches the claim.
    expect(db.releases).toEqual([]);
  });

  it("a genuine duplicate of an event other than checkout completion is acknowledged", async () => {
    await deliver({ id: "evt_other", type: "payment_intent.created" });
    const res = await deliver({ id: "evt_other", type: "payment_intent.created" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(db.entitlements).toEqual([]);
  });
});

// ──────────────────────────────────────────────────── retries and reconciling ──
describe("retry after a failed attempt", () => {
  it("a failed grant releases the claim, and the retry grants once", async () => {
    db.entitlementError = { code: "57014", message: "statement timeout" };
    const first = await deliver();
    expect(first.status).toBe(500);
    expect(db.ledger.has("evt_1")).toBe(false);
    expect(db.entitlements).toEqual([]);
    expect(sendMissionAccessEmail).not.toHaveBeenCalled();

    db.entitlementError = null;
    const retry = await deliver();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true });
    expect(db.entitlements).toHaveLength(1);
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
  });

  it("if the claim cannot even be released, the retry is reconciled and still grants", async () => {
    db.entitlementError = { code: "57014", message: "statement timeout" };
    db.releaseError = { message: "TypeError: fetch failed" };
    expect((await deliver()).status).toBe(500);
    // The event is stuck in the ledger — previously this meant every retry
    // was answered "duplicate" and the family never got the mission.
    expect(db.ledger.has("evt_1")).toBe(true);
    expect(logError).toHaveBeenCalledWith("stripe_claim_release_failed", expect.anything(), { eventId: "evt_1" });

    db.entitlementError = null;
    db.releaseError = null;
    const retry = await deliver();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true, duplicate: true });
    expect(db.entitlements).toEqual([expect.objectContaining({ child_id: "child-1", mission_id: "m-1" })]);
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
    // The reconciling delivery leaves the claim in place.
    expect(db.ledger.has("evt_1")).toBe(true);
  });

  it("a failure while reconciling a duplicate asks for another retry without releasing the claim", async () => {
    db.ledger.add("evt_1"); // claimed by an earlier delivery, maybe still in flight
    db.entitlementError = { code: "57014", message: "statement timeout" };
    const res = await deliver();
    expect(res.status).toBe(500);
    expect(db.releases).toEqual([]);
    expect(db.ledger.has("evt_1")).toBe(true);
  });
});

// ──────────────────────────────────────────────────── entitlement idempotency ──
describe("entitlement idempotency", () => {
  it("a different event for an already-granted purchase grants nothing new and sends no email", async () => {
    await deliver({ id: "evt_1" });
    const res = await deliver({ id: "evt_2" });
    expect(res.status).toBe(200);
    expect(db.entitlements).toHaveLength(1);
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
  });

  it("many deliveries of the same event leave exactly one entitlement", async () => {
    for (let i = 0; i < 5; i++) expect((await deliver()).status).toBe(200);
    expect(db.entitlements).toHaveLength(1);
    expect(sendMissionAccessEmail).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("a REVOKED entitlement is not reactivated by a payment, and the payment is flagged", async () => {
    db.entitlements = [{ child_id: "child-1", mission_id: "m-1", source: "admin", status: "revoked" }];
    const res = await deliver();
    expect(res.status).toBe(200);
    // Revocation is undone only explicitly (D-20) — the row is exactly as it was.
    expect(db.entitlements).toEqual([
      { child_id: "child-1", mission_id: "m-1", source: "admin", status: "revoked" },
    ]);
    expect(sendMissionAccessEmail).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "stripe_paid_entitlement_revoked",
      expect.anything(),
      { sessionId: "cs_1" },
    );
  });
});

// ─────────────────────────────────────────────────── resolving the intent ──
describe("resolving the checkout intent", () => {
  it("a failed lookup releases the claim and asks Stripe to retry", async () => {
    db.intentError = { message: "timeout" };
    const res = await deliver();
    expect(res.status).toBe(500);
    expect(db.releases).toEqual(["evt_1"]);
    expect(db.ledger.has("evt_1")).toBe(false);
    expect(db.entitlements).toEqual([]);
  });

  it("a failed lookup on a duplicate does not release a claim that is not its own", async () => {
    db.ledger.add("evt_1");
    db.intentError = { message: "timeout" };
    expect((await deliver()).status).toBe(500);
    expect(db.releases).toEqual([]);
  });

  it("a genuinely missing intent is acknowledged and grants nothing", async () => {
    db.intents.clear();
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unmatched: true });
    expect(db.releases).toEqual([]);
    expect(db.entitlements).toEqual([]);
  });

  it("rejects a Checkout whose child metadata disagrees with the authoritative intent", async () => {
    const res = await deliver({ session: { metadata: { child_id: "someone-else" } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mismatch: true });
    expect(db.entitlements).toEqual([]);
  });
});

// ───────────────────────────────────────── only verified, paid, matching (D-113) ──
describe("only a verified, paid, matching payment grants access", () => {
  it("an invalid signature is refused before anything is claimed", async () => {
    const res = await deliver({ signature: "t=1,v1=forged" });
    expect(res.status).toBe(400);
    expect(db.ledger.size).toBe(0);
    expect(db.entitlements).toEqual([]);
  });

  it("a completed but UNPAID session — how a delayed method completes — grants nothing", async () => {
    const res = await deliver({ session: { payment_status: "unpaid" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unpaid: true });
    expect(db.entitlements).toEqual([]);
  });

  it("a later async success event is not a grant path (card only, D-113)", async () => {
    const res = await deliver({ type: "checkout.session.async_payment_succeeded" });
    expect(res.status).toBe(200);
    expect(db.entitlements).toEqual([]);
  });

  it("an amount other than the one recorded grants nothing", async () => {
    const res = await deliver({ session: { amount_total: 100 } });
    expect(await res.json()).toMatchObject({ mismatch: true });
    expect(db.entitlements).toEqual([]);
  });

  it("a currency other than the one recorded grants nothing", async () => {
    const res = await deliver({ session: { currency: "usd" } });
    expect(await res.json()).toMatchObject({ mismatch: true });
    expect(db.entitlements).toEqual([]);
  });
});

describe("a gift (D-140)", () => {
  const GIFT = {
    id: "gift-1", purchaser_id: "parent-1", mission_id: "mission-1", recipient_email: "r@example.test", stripe_session_id: "cs_1",
    amount_minor: 1200, currency: "GBP", status: "pending", link_sent_at: null,
  };
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://academy.test");
    db.intents.clear();
    db.gifts = [{ ...GIFT }];
  });

  it("payment activates the gift, grants nobody anything, and sends one email", async () => {
    const { sendGiftEmail } = await import("@/lib/email/send");
    vi.mocked(sendGiftEmail).mockClear();
    const res = await deliver({ session: { amount_total: 1200, currency: "gbp" } });
    expect(res.status).toBe(200);
    expect(db.gifts[0].status).toBe("paid");
    expect(db.entitlements).toEqual([]);
    expect(sendGiftEmail).toHaveBeenCalledTimes(1);
  });

  it("a repeated event creates no second gift and no second email", async () => {
    const { sendGiftEmail } = await import("@/lib/email/send");
    vi.mocked(sendGiftEmail).mockClear();
    const session = { amount_total: 1200, currency: "gbp" };
    await deliver({ session });
    const hash = db.gifts[0].redeem_token_hash;
    const res = await deliver({ session });
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(db.gifts).toHaveLength(1);
    expect(db.gifts[0].redeem_token_hash).toBe(hash);
    expect(sendGiftEmail).toHaveBeenCalledTimes(1);
  });

  it("an unpaid session activates nothing", async () => {
    const res = await deliver({ session: { payment_status: "unpaid", amount_total: 1200, currency: "gbp" } });
    expect(await res.json()).toMatchObject({ unpaid: true });
    expect(db.gifts[0].status).toBe("pending");
    expect(db.gifts[0].redeem_token_hash).toBeUndefined();
  });

  it("an amount that doesn't match what was recorded activates nothing", async () => {
    const res = await deliver({ session: { amount_total: 1, currency: "gbp" } });
    expect(await res.json()).toMatchObject({ mismatch: true });
    expect(db.gifts[0].status).toBe("pending");
  });

  it("an email that might work next time is retried: the recipient has no other way to hear", async () => {
    const { sendGiftEmail } = await import("@/lib/email/send");
    vi.mocked(sendGiftEmail).mockClear();
    vi.mocked(sendGiftEmail).mockResolvedValueOnce({ sent: false, reason: "http_503" });
    const res = await deliver({ session: { amount_total: 1200, currency: "gbp" } });
    expect(res.status).toBe(500);
    expect(db.releases.length).toBe(1);
    expect(db.gifts[0].status).toBe("paid");
    const again = await deliver({ session: { amount_total: 1200, currency: "gbp" } });
    expect(again.status).toBe(200);
    expect(sendGiftEmail).toHaveBeenCalledTimes(2);
  });

  it("email not being configured doesn't make Stripe retry for days", async () => {
    const { sendGiftEmail } = await import("@/lib/email/send");
    vi.mocked(sendGiftEmail).mockResolvedValueOnce({ sent: false, reason: "not_configured" });
    const res = await deliver({ session: { amount_total: 1200, currency: "gbp" } });
    expect(res.status).toBe(200);
    expect(db.gifts[0].status).toBe("paid");
  });

  it("a failed gift lookup is retried rather than dropped", async () => {
    db.giftError = { message: "timeout" };
    const res = await deliver({ session: { amount_total: 1200, currency: "gbp" } });
    expect(res.status).toBe(500);
    expect(db.releases.length).toBe(1);
  });
});
