import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

/*
 * The server side of gifting (D-149), run: real actions, real code handling and
 * real encryption of the purchaser's copy, over an in-memory database. What the
 * database itself refuses (attempt limits, single use, races, cross-family) is
 * executed against the real schema in scripts/gift-regression.sql.
 */
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  gifts: [] as Row[],
  profiles: [] as Row[],
  rpc: vi.fn(),
  sendGift: vi.fn(),
  cookies: new Map<string, string>(),
  cookieOptions: [] as unknown[],
  headers: new Headers(),
  redirects: [] as string[],
  parent: "parent-1",
  ownedChildren: new Set(["child-1"]),
}));

vi.mock("@/lib/email/send", () => ({ sendGiftPurchaseEmail: db.sendGift }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(() => "ref"), logWarn: vi.fn() }));
vi.mock("@/features/children/active-child", () => ({ setActiveChild: vi.fn(async () => {}) }));
vi.mock("@/features/commerce/checkout", () => ({
  CheckoutError: class extends Error {
    constructor(message: string, readonly reason: string) { super(message); }
  },
  missionLineItem: vi.fn(),
  stripe: vi.fn(),
}));
vi.mock("../checkout", () => ({ purchaseGift: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { db.redirects.push(to); throw new Error("NEXT_REDIRECT"); },
}));
vi.mock("next/headers", () => ({
  headers: async () => db.headers,
  cookies: async () => ({
    get: (n: string) => (db.cookies.has(n) ? { value: db.cookies.get(n) } : undefined),
    set: (n: string, v: string, o: unknown) => { db.cookies.set(n, v); db.cookieOptions.push(o); },
    delete: (o: { name: string }) => { db.cookies.delete(o.name); },
  }),
}));
vi.mock("@/lib/permissions", () => {
  class AccessError extends Error {}
  return {
    AccessError,
    requireParent: async () => ({ user: { id: db.parent } }),
    requireOwnedChild: async (id: string) => {
      if (!db.ownedChildren.has(id)) throw new AccessError("no");
      return { child: { id } };
    },
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: db.rpc,
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      let patch: Row | null = null;
      const rows = () => (table === "profiles" ? db.profiles : table === "missions" ? [{ id: "m1", title: "Six Names" }] : db.gifts);
      const matches = () => rows().filter((g) => filters.every(([k, v]) => g[k] === v));
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: Row) => { patch = p; return q; };
      q.eq = (k: string, v: unknown) => { filters.push([k, v]); return q; };
      q.maybeSingle = async () => ({ data: matches()[0] ?? null, error: null });
      q.then = (resolve: (v: unknown) => void) => {
        const found = matches();
        if (patch) found.forEach((r) => Object.assign(r, patch));
        resolve({ data: found.map((r) => ({ ...r })), error: null });
      };
      return q;
    },
  }),
}));

import { fulfilPaidGift } from "../fulfil";
import { confirmGiftCodeAction, giftMissionAction, redeemGiftAction, reissueGiftCodeAction } from "../actions";
import { listPurchasedGifts } from "../purchaser";
import { purchaseGift } from "../checkout";
import { formatGiftCode, giftCodeSchema } from "../schemas";
import { hashGiftToken, newGiftToken } from "../token";
import { openCode } from "@/features/child-auth/code-crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { CANCELLATION_ACKNOWLEDGEMENT, EARLY_SUPPLY_CONSENT } from "@/features/commerce/consent";

const KEY = randomBytes(32).toString("base64");
const CODE = "ABCD-EFGH-JKMN";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  Object.entries(o).forEach(([k, v]) => f.set(k, v));
  return f;
};
/** What the database does for these functions; the SQL itself runs in gift-regression.sql. */
function database({ activation = "activated", confirm = "matched" } = {}) {
  db.rpc.mockImplementation(async (name: string, a: Record<string, string>) => {
    switch (name) {
      case "activate_paid_gift": {
        const g = db.gifts.find((x) => x.stripe_session_id === a.p_session_id);
        if (!g) return { data: [{ outcome: "not_found", gift_id: null, code: null }], error: null };
        if (activation !== "activated" || g.status !== "pending") return { data: [{ outcome: "already", gift_id: g.id, code: null }], error: null };
        Object.assign(g, { status: "paid", paid_at: "2026-11-06T10:00:00Z", stripe_payment_intent_id: a.p_payment_intent, code_lookup: `hmac(${a.p_session_id})` });
        return { data: [{ outcome: "activated", gift_id: g.id, code: CODE }], error: null };
      }
      case "store_gift_code_copy": {
        const g = db.gifts.find((x) => x.id === a.p_gift_id && x.status === "paid");
        if (!g) return { data: false, error: null };
        g.code_ciphertext = a.p_ciphertext;
        return { data: true, error: null };
      }
      case "confirm_gift_code":
        if (confirm === "matched" && db.gifts[0]) db.gifts[0].claim_hash = a.p_claim_hash;
        return { data: confirm, error: null };
      case "reissue_gift_code": {
        const g = db.gifts.find((x) => x.id === a.p_gift_id && x.purchaser_id === a.p_purchaser_id && x.status === "paid");
        if (!g) return { data: null, error: null };
        g.code_ciphertext = null;
        return { data: "PQRS-TVWX-YZ23", error: null };
      }
      case "purchaser_gifts":
        return { data: db.gifts.filter((g) => g.purchaser_id === a.p_purchaser_id).map((g) => ({ ...g, mission_title: "Six Names", mission_slug: "six-names" })), error: null };
      default:
        return { data: null, error: null };
    }
  });
}
const pending = (): Row => ({
  id: "g1", mission_id: "m1", purchaser_id: "parent-1", stripe_session_id: "cs_1",
  amount_minor: 1200, currency: "GBP", status: "pending", code_ciphertext: null,
  consent_wording: `2026-11-06 | ${EARLY_SUPPLY_CONSENT} | ${CANCELLATION_ACKNOWLEDGEMENT}`,
  early_supply_consent_at: "2026-11-06T09:59:00Z", created_at: "2026-11-06T09:59:00Z",
});

beforeEach(() => {
  vi.stubEnv("CHILD_CODE_ENCRYPTION_KEY", KEY);
  db.gifts = [pending()];
  db.profiles = [{ id: "parent-1", email: "buyer@example.test" }];
  db.rpc.mockReset();
  database();
  db.sendGift.mockReset().mockResolvedValue({ sent: true });
  db.cookies.clear();
  db.cookieOptions = [];
  db.headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
  db.redirects = [];
  db.parent = "parent-1";
  db.ownedChildren = new Set(["child-1"]);
  vi.mocked(purchaseGift).mockReset();
});

describe("activation by the verified webhook", () => {
  it("makes the gift redeemable, keeps only an encrypted copy, and emails the code to the PURCHASER", async () => {
    expect(await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1")).toBe("activated");
    const g = db.gifts[0];
    expect(g.status).toBe("paid");
    expect(g.stripe_payment_intent_id).toBe("pi_1");
    // The copy opens to the code with the server's key, bound to this gift only.
    expect(openCode(String(g.code_ciphertext), { giftId: "g1" }, { current: KEY })).toBe(CODE);
    expect(() => openCode(String(g.code_ciphertext), { giftId: "g2" }, { current: KEY })).toThrow();
    expect(String(g.code_ciphertext)).not.toContain("ABCD");
    expect(db.sendGift).toHaveBeenCalledOnce();
    const mail = db.sendGift.mock.calls[0][0];
    expect(mail.to).toBe("buyer@example.test");
    expect(mail.code).toBe(CODE);
    expect(mail.consentRecorded).toBe(true);
    expect(mail.consentWording).toContain(EARLY_SUPPLY_CONSENT);
    expect(g.confirmation_sent_at).toBeTruthy();
  });

  it("asks for no recipient: nothing about the gift names one", async () => {
    await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1");
    expect(Object.keys(db.gifts[0]).some((k) => /recipient/.test(k))).toBe(false);
    expect(Object.keys(db.sendGift.mock.calls[0][0]).some((k) => /recipient/.test(k))).toBe(false);
  });

  it("a repeated or concurrent delivery activates nothing, makes no copy and sends nothing", async () => {
    database({ activation: "already" });
    expect(await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1")).toBe("already");
    expect(db.sendGift).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("store_gift_code_copy", expect.anything());
  });

  it("no encryption key: no copy is kept, but the purchaser is still emailed the code", async () => {
    vi.stubEnv("CHILD_CODE_ENCRYPTION_KEY", "");
    expect(await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1")).toBe("activated");
    expect(db.gifts[0].code_ciphertext).toBeNull();
    expect(db.sendGift).toHaveBeenCalledOnce();
  });

  it("an email that doesn't leave doesn't fail the webhook, and no confirmation is recorded", async () => {
    db.sendGift.mockResolvedValue({ sent: false, reason: "http_503" });
    expect(await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1")).toBe("activated");
    expect(db.gifts[0].confirmation_sent_at).toBeUndefined();
    expect(db.gifts[0].status).toBe("paid");
  });

  it("a database failure throws, so the webhook answers 500 and Stripe retries", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(fulfilPaidGift(createAdminClient(), "cs_1", "pi_1")).rejects.toBeTruthy();
    expect(db.sendGift).not.toHaveBeenCalled();
  });
});

describe("the purchaser's gifts", () => {
  it("show the code, opened on the server, and never the stored copy", async () => {
    await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1");
    const [g] = await listPurchasedGifts();
    expect(g.code).toBe(CODE);
    expect(JSON.stringify(g)).not.toContain(String(db.gifts[0].code_ciphertext));
    expect(db.rpc).toHaveBeenCalledWith("purchaser_gifts", { p_purchaser_id: "parent-1" });
  });

  it("a copy that can't be opened says so, and offers a new code instead of failing", async () => {
    await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1");
    vi.stubEnv("CHILD_CODE_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    const [g] = await listPurchasedGifts();
    expect(g.code).toBeNull();
    expect(g.codeUnavailable).toBe("unreadable");
  });

  it("a pending or redeemed gift shows no code", async () => {
    const [g] = await listPurchasedGifts();
    expect(g.status).toBe("pending");
    expect(g.code).toBeNull();
  });

  it("only the purchaser's own: the id comes from the session, never the form", async () => {
    db.parent = "someone-else";
    expect(await listPurchasedGifts()).toEqual([]);
  });
});

describe("replacing a code", () => {
  beforeEach(async () => { await fulfilPaidGift(createAdminClient(), "cs_1", "pi_1"); });

  it("needs the confirmation box", async () => {
    const r = await reissueGiftCodeAction({}, form({ giftId: "g1" }));
    expect(r.error).toMatch(/Tick the box/);
    expect(db.rpc).not.toHaveBeenCalledWith("reissue_gift_code", expect.anything());
  });

  it("re-asserts the purchaser, shows the new code and keeps a new copy", async () => {
    const r = await reissueGiftCodeAction({}, form({ giftId: "g1", confirm: "yes", purchaserId: "attacker" }));
    expect(db.rpc).toHaveBeenCalledWith("reissue_gift_code", { p_gift_id: "g1", p_purchaser_id: "parent-1" });
    expect(r.code).toBe("PQRS-TVWX-YZ23");
    expect(openCode(String(db.gifts[0].code_ciphertext), { giftId: "g1" }, { current: KEY })).toBe("PQRS-TVWX-YZ23");
  });

  it("another family's gift gets nothing", async () => {
    db.parent = "someone-else";
    const r = await reissueGiftCodeAction({}, form({ giftId: "g1", confirm: "yes" }));
    expect(r.code).toBeUndefined();
    expect(r.error).toMatch(/can't have a new code/);
  });
});

describe("entering a code (no email address anywhere)", () => {
  it("accepts the code however it was typed, and asks for nothing else", async () => {
    await expect(confirmGiftCodeAction({}, form({ code: " abcd efgh-jkmn. " }))).rejects.toThrow("NEXT_REDIRECT");
    const [, args] = db.rpc.mock.calls.find(([n]) => n === "confirm_gift_code")!;
    expect(args.p_code).toBe("ABCDEFGHJKMN");
    expect(Object.keys(args)).toEqual(["p_code", "p_client", "p_claim_hash"]);
  });

  it("a correct code gives an httpOnly claim cookie and only the claim's hash reaches the database", async () => {
    await expect(confirmGiftCodeAction({}, form({ code: CODE }))).rejects.toThrow("NEXT_REDIRECT");
    const claim = db.cookies.get("wla_gift_claim")!;
    expect(db.gifts[0].claim_hash).toBe(hashGiftToken(claim));
    expect(db.cookieOptions[0]).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(db.redirects).toEqual(["/redeem"]);
  });

  it("the attempt limit is per client: the first forwarded address is passed for hashing", async () => {
    await expect(confirmGiftCodeAction({}, form({ code: CODE }))).rejects.toThrow();
    const [, args] = db.rpc.mock.calls.find(([n]) => n === "confirm_gift_code")!;
    expect(args.p_client).toBe("203.0.113.7");
  });

  it("a wrong, used or unpaid code is one message, no cookie, and at least the time floor", async () => {
    database({ confirm: "invalid" });
    const started = Date.now();
    const r = await confirmGiftCodeAction({}, form({ code: CODE }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(r.error).toMatch(/isn't right, or it has already been used/);
    expect(db.cookies.size).toBe(0);
  });

  it("too many tries is said plainly", async () => {
    database({ confirm: "rate_limited" });
    const r = await confirmGiftCodeAction({}, form({ code: CODE }));
    expect(r.error).toMatch(/wait 15 minutes/);
    expect(db.cookies.size).toBe(0);
  });

  it("something that isn't a code is refused before the database", async () => {
    const r = await confirmGiftCodeAction({}, form({ code: "ABCD-1234" }));
    expect(r.fieldErrors?.code).toMatch(/twelve-character/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("a database failure isn't reported as a wrong code", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    const r = await confirmGiftCodeAction({}, form({ code: CODE }));
    expect(r.error).toMatch(/couldn't check/);
  });
});

describe("redeeming", () => {
  const claim = () => { const t = newGiftToken().token; db.cookies.set("wla_gift_claim", t); return t; };

  it("needs a claim from a correct code", async () => {
    const r = await redeemGiftAction({}, form({ childId: "child-1" }));
    expect(r.error).toMatch(/enter the gift code again/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("refuses another family's child before touching the gift", async () => {
    claim();
    const r = await redeemGiftAction({}, form({ childId: "someone-elses" }));
    expect(r.error).toMatch(/Choose who/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("redeems for the signed-in parent's child, using the claim's hash, and goes to My Missions", async () => {
    const secret = claim();
    db.rpc.mockResolvedValue({ data: "redeemed", error: null });
    await expect(redeemGiftAction({}, form({ childId: "child-1" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(db.rpc).toHaveBeenCalledWith("redeem_mission_gift", {
      p_claim_hash: hashGiftToken(secret), p_child_id: "child-1", p_parent_id: "parent-1",
    });
    expect(db.redirects).toEqual(["/academy/my-missions?added=1"]);
    expect(db.cookies.size).toBe(0);
  });

  it.each([
    ["already_owned", /already has this mission/, true],
    ["already_redeemed", /already been redeemed/, false],
    ["invalid", /enter the gift code again/, false],
    ["unavailable", /can't be added for that child/, true],
    ["forbidden", /Choose who/, true],
  ])("%s is explained and goes nowhere", async (outcome, message, keepsClaim) => {
    claim();
    db.rpc.mockResolvedValue({ data: outcome, error: null });
    const r = await redeemGiftAction({}, form({ childId: "child-1" }));
    expect(r.error).toMatch(message);
    expect(db.redirects).toEqual([]);
    expect(db.cookies.has("wla_gift_claim")).toBe(keepsClaim);
  });
});

describe("buying a gift", () => {
  it("asks for no recipient address, and passes both statements only when both are ticked", async () => {
    vi.mocked(purchaseGift).mockResolvedValue({ kind: "checkout", url: "https://checkout.stripe.test/x" });
    await expect(
      giftMissionAction("six-names", {}, form({ earlySupplyConsent: "yes", cancellationAcknowledged: "yes", recipientEmail: "ignored@example.test" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    const args = vi.mocked(purchaseGift).mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(["consent", "missionSlug", "origin"]);
    expect(args.consent?.wording).toContain(CANCELLATION_ACKNOWLEDGEMENT);
    expect(db.redirects).toEqual(["https://checkout.stripe.test/x"]);
  });

  it("one box ticked is no consent at all", async () => {
    vi.mocked(purchaseGift).mockResolvedValue({ kind: "checkout", url: "x" });
    await giftMissionAction("six-names", {}, form({ earlySupplyConsent: "yes" })).catch(() => {});
    expect(vi.mocked(purchaseGift).mock.calls[0][0].consent).toBeNull();
  });
});

describe("the code's shape", () => {
  it("normalises spaces, hyphens, case and punctuation, and refuses anything else", () => {
    expect(giftCodeSchema.parse("abcd efgh-jkmn.")).toBe("ABCDEFGHJKMN");
    expect(giftCodeSchema.safeParse("ABCD-EFGH-JKM0").success).toBe(false); // 0 isn't in the alphabet
    expect(giftCodeSchema.safeParse("ABCD-EFGH").success).toBe(false);
    expect(formatGiftCode("abcdefghjkmn")).toBe("ABCD-EFGH-JKMN");
  });
});
