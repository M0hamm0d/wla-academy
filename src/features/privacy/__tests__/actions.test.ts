import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Closing an account from the page (D-148): who may, what must be confirmed,
 * and what the browser is left holding. The closure itself is closure.test.ts
 * and scripts/privacy-regression.sql.
 */
const m = vi.hoisted(() => ({
  user: { id: "parent-1", email: "parent@example.test" } as { id: string; email?: string } | null,
  signIn: vi.fn(),
  close: vi.fn(),
  signOut: vi.fn(),
  clearActive: vi.fn(),
  cookieDeletes: [] as string[],
  redirects: [] as string[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signInWithPassword: m.signIn } }),
}));
vi.mock("@/lib/env", () => ({ publicEnv: { supabaseUrl: "http://127.0.0.1", supabaseAnonKey: "anon" } }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signOut: m.signOut } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/features/children/active-child", () => ({ clearActiveChild: m.clearActive }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { m.redirects.push(to); throw new Error("NEXT_REDIRECT"); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: (o: { name: string }) => m.cookieDeletes.push(o.name) }),
}));
vi.mock("@/lib/permissions", () => {
  class AccessError extends Error {}
  return {
    AccessError,
    requireParent: async () => {
      if (!m.user) throw new AccessError("no");
      return { user: m.user };
    },
    requireAdmin: vi.fn(),
  };
});
vi.mock("../closure", () => ({ closeParentAccount: m.close, retryOpenClosures: vi.fn(), runClosure: vi.fn() }));

import { closeAccountAction } from "../actions";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  Object.entries(o).forEach(([k, v]) => f.set(k, v));
  return f;
};

beforeEach(() => {
  m.user = { id: "parent-1", email: "parent@example.test" };
  m.signIn.mockReset().mockResolvedValue({ error: null });
  m.close.mockReset().mockResolvedValue({ state: "completed", deletionId: "del-1" });
  m.signOut.mockReset().mockResolvedValue({});
  m.clearActive.mockReset().mockResolvedValue(undefined);
  m.cookieDeletes = [];
  m.redirects = [];
});

describe("closing an account", () => {
  it("needs a signed-in parent", async () => {
    m.user = null;
    expect((await closeAccountAction({}, form({ understood: "yes", password: "pw" }))).error).toMatch(/sign in again/);
    expect(m.close).not.toHaveBeenCalled();
  });

  it("needs the box ticked, before the password is even checked", async () => {
    const r = await closeAccountAction({}, form({ password: "pw" }));
    expect(r.fieldErrors?.understood).toBeTruthy();
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
  });

  it("needs the account's own password: the session alone isn't verification", async () => {
    m.signIn.mockResolvedValue({ error: { code: "invalid_credentials" } });
    const r = await closeAccountAction({}, form({ understood: "yes", password: "wrong" }));
    expect(r.fieldErrors?.password).toMatch(/isn't right/);
    expect(m.signIn).toHaveBeenCalledWith({ email: "parent@example.test", password: "wrong" });
    expect(m.close).not.toHaveBeenCalled();
  });

  it("closes the SESSION's account, whatever id the form sends, then signs out and forgets the family", async () => {
    await expect(
      closeAccountAction({}, form({ understood: "yes", password: "right", parentId: "someone-else" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(m.close).toHaveBeenCalledExactlyOnceWith("parent-1", "parent");
    expect(m.signOut).toHaveBeenCalled();
    expect(m.clearActive).toHaveBeenCalled();
    expect(m.cookieDeletes).toContain("wla_gift_claim");
    expect(m.redirects).toEqual(["/account-closed?state=done"]);
  });

  it("a closure still finishing says so, rather than claiming it's done", async () => {
    m.close.mockResolvedValue({ state: "pending", deletionId: "del-1", step: "files" });
    await expect(closeAccountAction({}, form({ understood: "yes", password: "right" }))).rejects.toThrow();
    expect(m.redirects).toEqual(["/account-closed?state=pending"]);
  });

  it("a closure under a hold says the records are kept, not that they'll go", async () => {
    m.close.mockResolvedValue({ state: "held", deletionId: "del-1" });
    await expect(closeAccountAction({}, form({ understood: "yes", password: "right" }))).rejects.toThrow();
    expect(m.redirects).toEqual(["/account-closed?state=held"]);
  });

  it("an administrator's account isn't closed this way", async () => {
    m.close.mockResolvedValue({ state: "refused", reason: "admin_account" });
    const r = await closeAccountAction({}, form({ understood: "yes", password: "right" }));
    expect(r.error).toMatch(/administrator/);
    expect(m.signOut).not.toHaveBeenCalled();
  });

  it("a failure to start deletes nothing and says so", async () => {
    m.close.mockRejectedValue(new Error("down"));
    const r = await closeAccountAction({}, form({ understood: "yes", password: "right" }));
    expect(r.error).toMatch(/Nothing has been deleted/);
  });
});
