import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retry = vi.hoisted(() => vi.fn());
vi.mock("@/features/privacy/closure", () => ({ retryOpenClosures: retry }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { GET } from "../route";

const call = (auth?: string) =>
  GET(new Request("https://academy.test/api/cron/privacy", { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => retry.mockReset().mockResolvedValue({ attempted: 1, completed: 1, orphanFilesRemoved: 0 }));
afterEach(() => vi.unstubAllEnvs());

describe("the closure follow-up endpoint (D-148)", () => {
  it("refuses everything when no secret is configured: an open deleting endpoint isn't acceptable", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect(retry).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong secret, and a secret too short to trust", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-enough-secret-value");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-secret-value-here!")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await call("Bearer short")).status).toBe(401);
    expect(retry).not.toHaveBeenCalled();
  });

  it("with the secret, runs the follow-up and answers counts only", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-enough-secret-value");
    const res = await call("Bearer a-long-enough-secret-value");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attempted: 1, completed: 1, orphanFilesRemoved: 0 });
  });
});
