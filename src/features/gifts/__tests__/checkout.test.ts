import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  attempt: null as Record<string, unknown> | null,
  attempts: 0,
  order: [] as string[],
  sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() },
}));

vi.mock("stripe", () => ({ default: class { checkout = { sessions: state.sessions }; } }));
vi.mock("@/lib/env", () => ({ stripeEnv: () => ({ STRIPE_SECRET_KEY: "sk_test" }) }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/permissions", () => ({
  requireParent: async () => ({ user: { id: "parent-1", email: "parent@example.test" }, supabase: {
    from: () => ({ select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: {
      id: "mission-1", slug: "mission", title: "Mission", description: null,
      is_free: false, published: true, price_minor: 1200, currency: "GBP",
    } }) }) }),
  } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => {
    const filters: Record<string, unknown> = {};
    let inserted: Record<string, unknown> | null = null;
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> & { [k: string]: (...args: never[]) => unknown } = {};
    q.select = () => q;
    q.eq = (k: string, v: unknown) => { filters[k] = v; return q; };
    q.in = () => q;
    q.insert = (value: Record<string, unknown>) => { inserted = value; return q; };
    q.update = (value: Record<string, unknown>) => { patch = value; return q; };
    q.maybeSingle = async () => {
      if (inserted) {
        state.order.push("db-reserve");
        if (state.attempt) return { data: null, error: { code: "23505" } };
        state.attempts++;
        state.attempt = { ...inserted, id: `gift-${state.attempts}`, attempt_key: `key-${state.attempts}`, stripe_session_id: null,
          status: "pending", checkout_status: "initializing", created_at: new Date().toISOString() };
        return { data: state.attempt, error: null };
      }
      const a = state.attempt;
      return { data: a && Object.entries(filters).every(([k, v]) => a[k] === v) ? a : null, error: null };
    };
    q.then = (resolve: (v: unknown) => void) => {
      if (patch && state.attempt) Object.assign(state.attempt, patch);
      resolve({ data: null, error: null });
    };
    return q;
  } }),
}));

import { purchaseGift } from "../checkout";

const CONSENT = { earlySupplyConsentAt: "2026-11-07T10:00:00Z", cancellationAckAt: "2026-11-07T10:00:00Z", wording: "2026-11-06 | a | b" };
const buy = () => purchaseGift({ missionSlug: "mission", origin: "https://academy.test", consent: CONSENT });

beforeEach(() => {
  state.attempt = null;
  state.attempts = 0;
  state.order = [];
  Object.values(state.sessions).forEach((fn) => fn.mockReset());
  state.sessions.create.mockImplementation(async () => {
    state.order.push("stripe-create");
    return { id: "cs_1", url: "https://checkout.stripe.test/cs_1", status: "open" };
  });
  state.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "open", url: "https://checkout.stripe.test/cs_1" });
});

describe("gift checkout attempt reliability", () => {
  it("persists the gift first and uses its database ID and attempt key", async () => {
    await buy();
    // No recipient address is recorded or asked for (D-149); the consent is.
    expect(state.attempt).not.toHaveProperty("recipient_email");
    expect(state.attempt).toMatchObject({ consent_wording: CONSENT.wording, early_supply_consent_at: CONSENT.earlySupplyConsentAt });
    expect(state.order.slice(0, 2)).toEqual(["db-reserve", "stripe-create"]);
    const [params, options] = state.sessions.create.mock.calls[0];
    expect(params.client_reference_id).toBe("gift-1");
    expect(params.metadata.gift_id).toBe("gift-1");
    expect(options.idempotencyKey).toBe("wla-gift-key-1");
    expect(state.attempt).toMatchObject({ checkout_status: "open", stripe_session_id: "cs_1" });
  });

  it("serializes concurrent submits to the same durable attempt and key", async () => {
    await Promise.all([
      buy(),
      buy(),
    ]);
    expect(state.attempts).toBe(1);
    expect(state.sessions.create).toHaveBeenCalledTimes(2);
    expect(state.sessions.create.mock.calls[0][1]).toEqual(state.sessions.create.mock.calls[1][1]);
  });

  it("reuses an existing open session and never creates another payable session", async () => {
    await buy();
    const result = await buy();
    expect(result).toEqual({ kind: "checkout", url: "https://checkout.stripe.test/cs_1" });
    expect(state.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("gives a later, separate gift of the same mission a different key", async () => {
    await buy();
    const firstKey = state.sessions.create.mock.calls[0][1].idempotencyKey;
    state.attempt = null;
    state.sessions.create.mockClear();
    await buy();
    expect(state.sessions.create.mock.calls[0][1].idempotencyKey).not.toBe(firstKey);
  });
});
