import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The server side of gifting, run: a small in-memory `mission_gifts`, real
 * token handling, real actions. What the database itself refuses is executed
 * in scripts/gift-regression.sql.
 */
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  gifts: [] as Row[],
  rpc: vi.fn(),
  send: vi.fn(),
  sendCode: vi.fn(),
  cookies: new Map<string, string>(),
  deleted: [] as unknown[],
  redirects: [] as string[],
  after: [] as (() => Promise<void>)[],
  parent: "parent-1",
  ownedChildren: new Set(["child-1"]),
  writeError: null as null | { message: string },
  rpcDown: false,
}));

vi.mock("@/lib/email/send", () => ({ sendGiftEmail: db.send, sendGiftCodeEmail: db.sendCode }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(() => "ref"), logWarn: vi.fn() }));
vi.mock("@/features/children/active-child", () => ({ setActiveChild: vi.fn(async () => {}) }));
vi.mock("@/features/commerce/checkout", () => ({
  CheckoutError: class extends Error {},
  missionLineItem: vi.fn(),
  stripe: vi.fn(),
}));
vi.mock("../checkout", () => ({ purchaseGift: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { db.redirects.push(to); throw new Error("NEXT_REDIRECT"); },
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { db.after.push(fn); } }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (n: string) => (db.cookies.has(n) ? { value: db.cookies.get(n) } : undefined),
    set: (n: string, v: string, o: unknown) => { db.cookies.set(n, v); db.deleted.push({ set: o }); },
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
      const matches = () => db.gifts.filter((g) => filters.every(([k, v]) => g[k] === v));
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: Row) => { patch = p; return q; };
      q.eq = (k: string, v: unknown) => { filters.push([k, v]); return q; };
      q.is = (k: string, v: unknown) => { filters.push([k, v]); return q; };
      q.limit = () => q;
      q.maybeSingle = async () => {
        if (table === "missions") return { data: { title: "Six Names" }, error: null };
        const [row] = matches();
        return { data: row ? { ...row, missions: { title: "Six Names", slug: "six-names" } } : null, error: null };
      };
      q.then = (resolve: (v: unknown) => void) => {
        if (db.writeError && patch) return resolve({ data: null, error: db.writeError });
        const rows = matches();
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        // Copies, as a real response is: what was read doesn't change afterwards.
        resolve({ data: rows.map((r) => ({ ...r })), error: null });
      };
      return q;
    },
  }),
}));

import { emailCodeFor, fulfilPaidGift, emailLinksFor } from "../fulfil";
import {
  confirmGiftCodeAction,
  confirmGiftEmailAction,
  giftMissionAction,
  redeemGiftAction,
  requestGiftCodeAction,
} from "../actions";
import { readClaimedGift } from "../redeem";
import { purchaseGift } from "../checkout";
import { hashGiftToken, newGiftToken } from "../token";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = () => createAdminClient();
/** The function's rules, in memory; the SQL itself runs in scripts/gift-regression.sql. */
const confirmRpc = async (name: string, a: Record<string, string>) => {
  if (name === "consume_gift_request_limit") return { data: true, error: null };
  if (name !== "confirm_gift_email") return { data: null, error: null };
  if (db.rpcDown) return { data: null, error: { message: "down" } };
  const g = db.gifts.find((x) => x.redeem_token_hash === a.p_token_hash);
  if (!g) return { data: "invalid", error: null };
  if (g.recipient_email !== a.p_email) return { data: "mismatch", error: null };
  if (g.status === "redeemed") return { data: "already_redeemed", error: null };
  g.claim_hash = a.p_claim_hash;
  return { data: "matched", error: null };
};
const form = (o: Record<string, string>) => {
  const f = new FormData();
  Object.entries(o).forEach(([k, v]) => f.set(k, v));
  return f;
};
const pending = (): Row => ({
  id: "g1", mission_id: "m1", recipient_email: "r@example.test", amount_minor: 1200, currency: "GBP",
  status: "pending", link_sent_at: null, redeem_token_hash: null,
});
const sentToken = () => new URL(db.send.mock.calls.at(-1)![0].redeemUrl).searchParams.get("token")!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fulfil = (g: Row) => fulfilPaidGift(admin(), g as any, "pi_1");

beforeEach(() => {
  vi.stubEnv("SITE_URL", "https://academy.test");
  db.gifts = [];
  db.rpc.mockReset().mockImplementation(confirmRpc);
  db.rpcDown = false;
  db.send.mockReset().mockResolvedValue({ sent: true });
  db.sendCode.mockReset().mockResolvedValue({ sent: true });
  db.cookies.clear();
  db.deleted = [];
  db.redirects = [];
  db.after = [];
  db.parent = "parent-1";
  db.ownedChildren = new Set(["child-1"]);
  db.writeError = null;
  vi.mocked(purchaseGift).mockReset();
});

describe("activation by the verified webhook", () => {
  it("makes a pending gift paid, emails the only copy of the token, and stores just its hash", async () => {
    const g = pending();
    db.gifts = [g];
    await fulfil({ ...g });
    expect(g.status).toBe("paid");
    expect(g.stripe_payment_intent_id).toBe("pi_1");
    expect(db.send).toHaveBeenCalledTimes(1);
    const token = sentToken();
    expect(g.redeem_token_hash).toBe(hashGiftToken(token));
    expect(JSON.stringify(g)).not.toContain(token);
    expect(g.link_sent_at).toBeTruthy();
    expect(db.send.mock.calls[0][0].to).toBe("r@example.test");
  });

  it("a repeated delivery activates nothing and sends nothing", async () => {
    const g = pending();
    db.gifts = [g];
    await fulfil({ ...g });
    const hash = g.redeem_token_hash;
    await fulfil({ ...g });
    expect(db.send).toHaveBeenCalledTimes(1);
    expect(g.redeem_token_hash).toBe(hash);
  });

  it("a concurrent delivery that loses the race sends nothing", async () => {
    const g = { ...pending(), status: "paid", link_sent_at: "now", redeem_token_hash: "h" };
    db.gifts = [g];
    await fulfil({ ...pending() }); // read it as pending, but the row has moved on
    expect(db.send).not.toHaveBeenCalled();
    expect(g.redeem_token_hash).toBe("h");
  });

  it("a gift already redeemed is left alone", async () => {
    const g = { ...pending(), status: "redeemed", redeem_token_hash: "h" };
    db.gifts = [g];
    await fulfil({ ...g });
    expect(db.send).not.toHaveBeenCalled();
  });

  it("an email that might work next time throws, so Stripe's retry sends it with a fresh token", async () => {
    const g = pending();
    db.gifts = [g];
    for (const reason of ["http_500", "http_429", "exception"]) {
      db.send.mockResolvedValueOnce({ sent: false, reason });
      g.status = "pending"; g.redeem_token_hash = null;
      await expect(fulfil({ ...g })).rejects.toThrow("gift_email_retry");
      expect(g.status).toBe("paid"); // the payment stands whatever the email did
      expect(g.link_sent_at).toBeNull();
    }
    const first = g.redeem_token_hash;
    await fulfil({ ...g });
    expect(g.redeem_token_hash).not.toBe(first);
    expect(g.link_sent_at).toBeTruthy();
  });

  it("an email that can't work on a retry doesn't fail the webhook", async () => {
    const g = pending();
    db.gifts = [g];
    db.send.mockResolvedValueOnce({ sent: false, reason: "not_configured" });
    await fulfil({ ...g });
    expect(g.status).toBe("paid");
    expect(g.link_sent_at).toBeNull();
  });

  it("a database failure throws, so the webhook answers 500 and Stripe retries", async () => {
    const g = pending();
    db.gifts = [g];
    db.writeError = { message: "down" };
    await expect(fulfil({ ...g })).rejects.toBeTruthy();
    expect(db.send).not.toHaveBeenCalled();
  });
});

describe("confirming an address", () => {
  const paid = () => {
    const { token, hash } = newGiftToken();
    db.gifts = [{ ...pending(), status: "paid", redeem_token_hash: hash, link_sent_at: "2020-01-01" }];
    return token;
  };

  it("the right address, however typed, gets the claim and the token leaves the URL", async () => {
    const token = paid();
    await expect(
      confirmGiftEmailAction({}, form({ token, email: " R@Example.TEST " })),
    ).rejects.toThrow("NEXT_REDIRECT");
    const claim = db.cookies.get("wla_gift_claim")!;
    expect(claim).not.toBe(token); // a link alone can't produce a claim (D-142)
    expect(db.gifts[0].claim_hash).toBe(hashGiftToken(claim));
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_email: "r@example.test" });
    expect(db.redirects).toEqual(["/redeem"]);
    expect(db.deleted[0]).toMatchObject({ set: { httpOnly: true, path: "/", sameSite: "lax" } });
  });

  it("a wrong address gets no claim and learns nothing about the gift", async () => {
    const token = paid();
    const r = await confirmGiftEmailAction({}, form({ token, email: "other@example.test" }));
    expect(r.error).toMatch(/isn't the email address/);
    expect(r.error).not.toMatch(/Six Names/);
    expect(db.cookies.size).toBe(0);
  });

  it("a wrong address can't even learn that the gift was redeemed", async () => {
    const token = paid();
    db.gifts[0].status = "redeemed";
    const r = await confirmGiftEmailAction({}, form({ token, email: "other@example.test" }));
    expect(r.error).toMatch(/isn't the email address/);
    const right = await confirmGiftEmailAction({}, form({ token, email: "r@example.test" }));
    expect(right.error).toMatch(/already been redeemed/);
  });

  it("an invalid or made-up token gets no claim", async () => {
    paid();
    for (const token of ["invalid", newGiftToken().token]) {
      const r = await confirmGiftEmailAction({}, form({ token, email: "r@example.test" }));
      expect(r.error).toMatch(/isn't valid/);
    }
    expect(db.cookies.size).toBe(0);
  });

  it("a database failure isn't reported as a wrong address", async () => {
    const token = paid();
    db.rpcDown = true;
    const r = await confirmGiftEmailAction({}, form({ token, email: "r@example.test" }));
    expect(r.error).toMatch(/try again/);
    expect(db.cookies.size).toBe(0);
  });

  it("a missing or malformed address is refused before anything is looked up", async () => {
    for (const email of ["", "not-an-email"]) {
      const r = await confirmGiftEmailAction({}, form({ token: "x", email }));
      expect(r.fieldErrors?.email).toBeTruthy();
    }
  });

  it("from the website, the answer is the same whether or not a gift exists", async () => {
    paid();
    const yes = await confirmGiftEmailAction({}, form({ email: "r@example.test" }));
    const no = await confirmGiftEmailAction({}, form({ email: "nobody@example.test" }));
    expect(yes).toEqual(no);
    expect(yes.notice).toBeTruthy();
    expect(db.cookies.size).toBe(0);
    // The work happens after the response, and only the right address gets mail.
    await Promise.all(db.after.map((fn) => fn()));
    expect(db.send).toHaveBeenCalledTimes(1);
    expect(db.send.mock.calls[0][0].to).toBe("r@example.test");
  });
});

describe("asking for the link again", () => {
  it("is throttled per gift", async () => {
    const { hash } = newGiftToken();
    const g = { ...pending(), status: "paid", redeem_token_hash: hash, link_sent_at: new Date().toISOString() };
    db.gifts = [g];
    await emailLinksFor(admin(), "r@example.test");
    expect(db.send).not.toHaveBeenCalled();
    expect(g.redeem_token_hash).toBe(hash);
  });

  it("simultaneous requests can't all pass the throttle", async () => {
    const g = { ...pending(), status: "paid", redeem_token_hash: "h", link_sent_at: null };
    db.gifts = [g];
    await Promise.all([1, 2, 3].map(() => emailLinksFor(admin(), "r@example.test")));
    expect(db.send).toHaveBeenCalledTimes(1);
  });

  it("a failed send gives the throttle back", async () => {
    const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const g = { ...pending(), status: "paid", redeem_token_hash: "h", link_sent_at: earlier };
    db.gifts = [g];
    db.send.mockResolvedValueOnce({ sent: false, reason: "http_500" });
    await emailLinksFor(admin(), "r@example.test");
    expect(g.link_sent_at).toBe(earlier);
    expect(g.redeem_token_hash).toBe("h");
  });

  it("a new link resets the count of wrong addresses", async () => {
    const g = { ...pending(), status: "paid", redeem_token_hash: "h", link_sent_at: null, confirm_failures: 10 };
    db.gifts = [g];
    await emailLinksFor(admin(), "r@example.test");
    expect(g.confirm_failures).toBe(0);
  });

  it("replaces the token only once the email has gone", async () => {
    const { hash } = newGiftToken();
    const g = { ...pending(), status: "paid", redeem_token_hash: hash, link_sent_at: null };
    db.gifts = [g];
    db.send.mockResolvedValueOnce({ sent: false, reason: "not_configured" });
    await emailLinksFor(admin(), "r@example.test");
    expect(g.redeem_token_hash).toBe(hash); // the old link still works
    await emailLinksFor(admin(), "r@example.test");
    expect(g.redeem_token_hash).toBe(hashGiftToken(sentToken()));
  });
});

describe("redeeming", () => {
  const claim = () => { const t = newGiftToken().token; db.cookies.set("wla_gift_claim", t); return t; };

  it("needs a confirmed claim", async () => {
    const r = await redeemGiftAction({}, form({ childId: "child-1" }));
    expect(r.error).toMatch(/confirm your email/);
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
    ["invalid", /confirm your email/, false],
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

describe("the gift toggle's action", () => {
  it("refuses a missing or invalid recipient before Stripe is involved", async () => {
    for (const recipientEmail of ["", "nope", "a@"]) {
      const r = await giftMissionAction("six-names", {}, form({ recipientEmail }));
      expect(r.fieldErrors?.recipientEmail).toBeTruthy();
    }
    expect(purchaseGift).not.toHaveBeenCalled();
  });

  it("a valid recipient goes on to Stripe", async () => {
    vi.mocked(purchaseGift).mockResolvedValue({ kind: "checkout", url: "https://stripe.test/c" });
    await expect(
      giftMissionAction("six-names", {}, form({ recipientEmail: "r@example.test" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(db.redirects).toEqual(["https://stripe.test/c"]);
  });
});

describe("redeeming from the website with a code (D-145)", () => {
  const CODE = "ABCD2345";
  const issuing = (rows: unknown[]) =>
    db.rpc.mockImplementation(async (name: string) => {
      if (name === "consume_gift_request_limit") return { data: true, error: null };
      if (name === "issue_gift_code") return { data: rows, error: null };
      if (name === "withdraw_gift_code") return { data: null, error: null };
      return { data: null, error: null };
    });
  const issued = [{ gift_id: "g1", mission_id: "m1", code: "ABCD-2345" }];
  const answering = (word: string) =>
    db.rpc.mockImplementation(async (name: string, a: Record<string, string>) => {
      if (name === "consume_gift_request_limit") return { data: true, error: null };
      if (name !== "confirm_gift_code") return { data: null, error: null };
      if (word === "matched") db.gifts[0].claim_hash = a.p_claim_hash;
      return { data: word, error: null };
    });

  it("asking gives the same answer whether or not a gift exists, and sends only after responding", async () => {
    issuing(issued);
    const yes = await requestGiftCodeAction({}, form({ email: "  R@Example.test " }));
    const no = await requestGiftCodeAction({}, form({ email: "nobody@example.test" }));
    expect(yes.notice).toBe(no.notice);
    expect(yes.notice).toMatch(/^If a gift was sent/);
    expect(db.rpc).toHaveBeenCalledTimes(2);
    expect(db.rpc).toHaveBeenCalledWith("consume_gift_request_limit", expect.objectContaining({ p_send: true }));
    expect(db.after).toHaveLength(2);
    expect(db.cookies.size).toBe(0);
  });

  it("rate-limits gift email requests across server instances without changing the generic response", async () => {
    db.rpc.mockResolvedValue({ data: false, error: null });
    const result = await requestGiftCodeAction({}, form({ email: "r@example.test" }));
    expect(result.notice).toMatch(/^If a gift was sent/);
    expect(db.after).toHaveLength(0);
  });

  it("no gift, or too soon: the database returns nothing and no email goes", async () => {
    issuing([]);
    await emailCodeFor(admin(), "nobody@example.test");
    expect(db.sendCode).not.toHaveBeenCalled();
  });

  it("a gift: the code goes only to that address, naming the mission", async () => {
    issuing(issued);
    await emailCodeFor(admin(), "r@example.test");
    expect(db.sendCode).toHaveBeenCalledExactlyOnceWith({
      to: "r@example.test",
      missionTitle: "Six Names",
      code: "ABCD-2345",
    });
  });

  it("a failed send withdraws the code, so asking again can work", async () => {
    issuing(issued);
    db.sendCode.mockResolvedValue({ sent: false, reason: "http_500" });
    await emailCodeFor(admin(), "r@example.test");
    expect(db.rpc).toHaveBeenCalledWith("withdraw_gift_code", { p_gift_id: "g1", p_code: "ABCD-2345" });
  });

  it("a successful send keeps it", async () => {
    issuing(issued);
    await emailCodeFor(admin(), "r@example.test");
    expect(db.rpc).not.toHaveBeenCalledWith("withdraw_gift_code", expect.anything());
  });

  it("a database failure while asking doesn't throw", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(emailCodeFor(admin(), "r@example.test")).resolves.toBeUndefined();
    expect(db.sendCode).not.toHaveBeenCalled();
  });

  it("the right code gets the claim cookie, as the link does, and sends only the claim's hash", async () => {
    db.gifts = [{ id: "g1", status: "paid" }];
    answering("matched");
    await expect(confirmGiftCodeAction({}, form({ email: "r@example.test", code: "abcd-2345" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(db.redirects).toEqual(["/redeem"]);
    const claim = db.cookies.get("wla_gift_claim")!;
    expect(claim).toBeTruthy();
    expect(db.gifts[0].claim_hash).toBe(hashGiftToken(claim));
    expect(db.rpc.mock.calls.find(([name]) => name === "confirm_gift_code")?.[1]).toMatchObject({ p_email: "r@example.test", p_code: CODE });
  });

  it("a wrong code, however the database got there, is one message and no cookie", async () => {
    answering("invalid");
    const wrong = await confirmGiftCodeAction({}, form({ email: "r@example.test", code: CODE }));
    const noGift = await confirmGiftCodeAction({}, form({ email: "nobody@example.test", code: CODE }));
    expect(wrong.error).toBe(noGift.error);
    expect(wrong.error).toMatch(/isn't right, or it has expired/);
    expect(db.cookies.size).toBe(0);
  });

  it("a wrong code and no gift take the same time, at least the floor", async () => {
    answering("invalid");
    const started = Date.now();
    await confirmGiftCodeAction({}, form({ email: "nobody@example.test", code: CODE }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
  });

  it("a malformed code isn't even sent", async () => {
    const result = await confirmGiftCodeAction({}, form({ email: "r@example.test", code: "abc" }));
    expect(result.fieldErrors?.code).toBeTruthy();
    expect(db.rpc).not.toHaveBeenCalledWith("confirm_gift_code", expect.anything());
  });

  it("a database failure isn't reported as a wrong code", async () => {
    db.rpc.mockImplementation(async (name) => name === "consume_gift_request_limit"
      ? { data: true, error: null }
      : { data: null, error: { message: "down" } });
    const result = await confirmGiftCodeAction({}, form({ email: "r@example.test", code: CODE }));
    expect(result.error).toMatch(/couldn't check/);
  });

  it("the address never goes in a URL, and the code never reaches a log or the page", async () => {
    answering("invalid");
    const logger = await import("@/lib/observability/logger");
    const result = await confirmGiftCodeAction({}, form({ email: "r@example.test", code: CODE }));
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(db.redirects).toEqual([]);
    expect(JSON.stringify(vi.mocked(logger.logWarn).mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(vi.mocked(logger.logError).mock.calls)).not.toContain(CODE);
  });

  it("the link still works alongside codes", async () => {
    const { token, hash } = newGiftToken();
    db.gifts = [{ id: "g1", status: "paid", recipient_email: "r@example.test", redeem_token_hash: hash }];
    await expect(confirmGiftEmailAction({}, form({ email: "r@example.test", token }))).rejects.toThrow("NEXT_REDIRECT");
    expect(db.cookies.get("wla_gift_claim")).toBeTruthy();
  });

  it("asking for a link instead keeps its own ten-minute limit", async () => {
    db.gifts = [{ id: "g1", mission_id: "m1", recipient_email: "r@example.test", status: "paid", link_sent_at: new Date().toISOString() }];
    await confirmGiftEmailAction({}, form({ email: "r@example.test" }));
    await Promise.all(db.after.map((fn) => fn()));
    expect(db.send).not.toHaveBeenCalled();
  });
});

describe("a claim expires in the database as well as in its cookie", () => {
  const claimed = (expires: Date | null) => {
    const { token, hash } = newGiftToken();
    db.gifts = [{ id: "g1", status: "paid", mission_id: "m1", claim_hash: hash, claim_expires_at: expires?.toISOString() ?? null }];
    return token;
  };

  it("an unexpired claim reads", async () => {
    const token = claimed(new Date(Date.now() + 60_000));
    await expect(readClaimedGift(token)).resolves.toMatchObject({ missionTitle: "Six Names" });
  });

  it("an expired claim shows nothing, even with the cookie still held", async () => {
    await expect(readClaimedGift(claimed(new Date(Date.now() - 1000)))).resolves.toBeNull();
  });
});
