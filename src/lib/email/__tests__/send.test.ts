import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isWorthRetrying, sendGiftPurchaseEmail, sendMissionAccessEmail } from "../send";
import { CANCELLATION_ACKNOWLEDGEMENT, EARLY_SUPPLY_CONSENT, consentWording } from "@/features/commerce/consent";
import { devMailpitUrl } from "../dev-mailpit";

const repo = join(__dirname, "../../../..");
const webhook = readFileSync(
  join(repo, "src/app/api/webhooks/stripe/route.ts"),
  "utf8",
);
const send = readFileSync(join(repo, "src/lib/email/send.ts"), "utf8");

const ORDER = {
  amountMinor: 1200,
  currency: "GBP",
  paidAt: "2026-11-06T10:00:00Z",
  consentWording: consentWording(),
  consentRecorded: true,
};
const EMAIL = {
  to: "parent@example.com",
  missionTitle: "Six Names",
  childName: "Amina",
  missionUrl: "http://localhost:3000/academy/missions/six-names",
  ...ORDER,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("transactional email", () => {
  it("skips cleanly when not configured, rather than failing", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    return expect(sendMissionAccessEmail(EMAIL)).resolves.toEqual({
      sent: false,
      reason: "not_configured",
    });
  });

  it("never logs the recipient or the child's name", () => {
    // Brief §46 — no unnecessary child information anywhere it needn't be.
    const logCalls = [...send.matchAll(/console\.(info|error)\(([^;]*)\);/g)].map((m) => m[2]);
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/\bto\b|childName|code|text/);
    }
  });

  it("never throws, whatever the provider does", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "test@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    await expect(sendMissionAccessEmail(EMAIL)).resolves.toEqual({
      sent: false,
      reason: "exception",
    });
  });

  it("reports a non-2xx without throwing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "test@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422 }));

    await expect(sendMissionAccessEmail(EMAIL)).resolves.toEqual({
      sent: false,
      reason: "http_422",
    });
  });

  it("sends when configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "test@example.com");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMissionAccessEmail(EMAIL)).resolves.toEqual({ sent: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toBe("parent@example.com");
    expect(body.subject).toBe("Order confirmed: Amina now has Six Names");
    expect(body.text).toContain("Amina now has Six Names.");
    expect(body.text).toContain("/academy/missions/six-names");
  });

  it("is the order confirmation on a durable medium: price, date and both statements as agreed (D-152)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "test@example.com");
    vi.stubEnv("NEXT_PUBLIC_TERMS_URL", "https://site.test/terms");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await sendMissionAccessEmail(EMAIL);
    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text as string;
    expect(text).toContain("£12.00");
    expect(text).toContain("6 November 2026");
    expect(text).toContain(EARLY_SUPPLY_CONSENT);
    expect(text).toContain(CANCELLATION_ACKNOWLEDGEMENT);
    expect(text).toMatch(/right to cancel no longer applies/);
    expect(text).toContain("https://site.test/terms");
    expect(text).toMatch(/Keep this email as your order confirmation/);
  });

  it("an order placed before consent was recorded doesn't claim it was given", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "test@example.com");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await sendMissionAccessEmail({ ...EMAIL, consentRecorded: false, consentWording: null });
    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text as string;
    expect(text).not.toContain(EARLY_SUPPLY_CONSENT);
    expect(text).not.toMatch(/no longer applies/);
  });

  it("only failures that might work next time are worth Stripe's retry", () => {
    expect(isWorthRetrying("exception")).toBe(true);
    expect(isWorthRetrying("http_503")).toBe(true);
    expect(isWorthRetrying("http_429")).toBe(true);
    expect(isWorthRetrying("not_configured")).toBe(false);
    expect(isWorthRetrying("http_422")).toBe(false);
  });

  it("carries no upsell or marketing", () => {
    // Architecture §14 keeps completion free of upsell; the same restraint
    // applies to the one transactional message.
    for (const forbidden of [/buy|discount|offer|upgrade|subscribe|unsubscribe/i]) {
      expect(send).not.toMatch(forbidden);
    }
  });
});

describe("email is wired after the entitlement, never before", () => {
  it("is sent only once the entitlement write has succeeded", () => {
    const grantAt = webhook.indexOf('from("mission_entitlements")');
    const emailAt = webhook.indexOf("notifyAccessGranted(");
    expect(grantAt).toBeGreaterThan(-1);
    expect(grantAt).toBeLessThan(emailAt);
  });

  it("the helper never throws; only a send worth retrying asks Stripe to deliver again (D-152)", () => {
    const helper = webhook.slice(webhook.indexOf("async function notifyAccessGranted"));
    expect(helper).toContain("try {");
    expect(helper).toContain("catch");
    expect(helper).not.toContain("status: 500");
    const call = webhook.slice(webhook.indexOf("if (active && !intent.confirmation_sent_at)"), webhook.indexOf("return duplicate", webhook.indexOf("if (active && !intent.confirmation_sent_at)")));
    expect(call).toContain("isWorthRetrying(outcome.reason)");
    expect(call).toContain("confirmation_sent_at");
  });

  it("no notification system was introduced", () => {
    /*
     * Architecture §22 defers notifications entirely.
     *
     * Checked against executable code, not prose — the module's own comment
     * names notifications in order to rule them out.
     */
    const code = send
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .toLowerCase();
    for (const forbidden of ["notification", "digest", "reminder", "campaign"]) {
      expect(code).not.toContain(forbidden);
    }
    // Exactly the two order confirmations, by name: a mission (D-27, D-152) and
    // a gift with its code, to the purchaser (D-149). No message to a gift's
    // recipient, and no message catalogue.
    const exported = [...send.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["sendGiftPurchaseEmail", "sendMissionAccessEmail"]);
    expect(send).not.toMatch(/recipient_?email|redeemUrl/i);
  });
});

describe("the gift purchase email (D-149)", () => {
  const GIFT = { to: "buyer@example.test", missionTitle: "Six Names", code: "ABCD-EFGH-JKMN", ...ORDER };
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WLA_DEV_MAILPIT_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://academy.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("goes to the purchaser with the code to share, how to redeem, and the order confirmation", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "a@b.test");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendGiftPurchaseEmail(GIFT)).resolves.toEqual({ sent: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toBe("buyer@example.test");
    expect(body.subject).not.toContain("ABCD");
    expect(body.text).toContain("ABCD-EFGH-JKMN");
    expect(body.text).toContain("https://academy.test/redeem");
    expect(body.text).toMatch(/doesn't expire/);
    expect(body.text).toContain(CANCELLATION_ACKNOWLEDGEMENT);
    expect(body.text).toContain("£12.00");
  });

  it("logs neither the code nor the address, whatever happens", async () => {
    const logged: string[] = [];
    for (const level of ["info", "error", "warn", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
    }
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    await sendGiftPurchaseEmail(GIFT);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "a@b.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(sendGiftPurchaseEmail(GIFT)).resolves.toEqual({ sent: false, reason: "http_500" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ABCD-EFGH-JKMN in message")));
    await expect(sendGiftPurchaseEmail(GIFT)).resolves.toEqual({ sent: false, reason: "exception" });
    expect(logged.join()).not.toContain("ABCD-EFGH-JKMN");
    expect(logged.join()).not.toContain("buyer@example.test");
  });

  it("without configuration it sends nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendGiftPurchaseEmail(GIFT)).resolves.toEqual({ sent: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("local Mailpit delivery can't reach production (D-145)", () => {
  const LOCAL = "http://127.0.0.1:55324";
  it("works only in development with a loopback address", () => {
    expect(devMailpitUrl({ NODE_ENV: "development", WLA_DEV_MAILPIT_URL: LOCAL })).toBe(LOCAL);
    expect(devMailpitUrl({ NODE_ENV: "production", WLA_DEV_MAILPIT_URL: LOCAL })).toBeNull();
    expect(devMailpitUrl({ NODE_ENV: "test", WLA_DEV_MAILPIT_URL: LOCAL })).toBeNull();
    expect(devMailpitUrl({ NODE_ENV: "development" })).toBeNull();
  });
  it("refuses any other host, so mail can't be redirected", () => {
    for (const url of ["https://evil.example", "http://127.0.0.1.evil.example", "not a url"]) {
      expect(devMailpitUrl({ NODE_ENV: "development", WLA_DEV_MAILPIT_URL: url })).toBeNull();
    }
  });
});
