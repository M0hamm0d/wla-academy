import { afterEach, describe, expect, it, vi } from "vitest";

const { shipLedger, createAdminClient, logError } = vi.hoisted(() => ({
  shipLedger: vi.fn(), createAdminClient: vi.fn(() => ({ admin: true })), logError: vi.fn(),
}));
vi.mock("@/features/privacy/ledger", () => ({ shipLedger }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/observability/logger", () => ({ logError }));

import { POST } from "../route";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("privacy ledger shipping-only endpoint", () => {
  it("rejects unauthenticated calls without touching the database or ledger", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-enough-cron-secret");
    const response = await POST(new Request("https://academy.example/api/cron/privacy-ledger", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(shipLedger).not.toHaveBeenCalled();
  });

  it("calls only shipLedger and returns counts without invoking closure workflows", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-enough-cron-secret");
    shipLedger.mockResolvedValue({ state: "configured", shipped: 5 });
    const response = await POST(new Request("https://academy.example/api/cron/privacy-ledger", {
      method: "POST", headers: { authorization: "Bearer a-long-enough-cron-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shipped: 5 });
    expect(createAdminClient).toHaveBeenCalledOnce();
    expect(shipLedger).toHaveBeenCalledExactlyOnceWith({ admin: true });
  });

  it("fails closed when ledger shipping is not configured or available", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-enough-cron-secret");
    shipLedger.mockResolvedValue({ state: "misconfigured", shipped: 0 });
    const response = await POST(new Request("https://academy.example/api/cron/privacy-ledger", {
      method: "POST", headers: { authorization: "Bearer a-long-enough-cron-secret" },
    }));
    expect(response.status).toBe(503);
  });
});
