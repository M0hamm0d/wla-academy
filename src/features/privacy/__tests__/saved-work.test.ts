import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The family's saved work (D-148): what a child made, in a file they can keep.
 * The parent's own client reads it, so RLS decides; this checks the scoping
 * the code itself adds, and that a child's words can't become markup.
 */
const m = vi.hoisted(() => ({ owned: new Set(["child-a"]), queries: [] as string[] }));

const tables: Record<string, Record<string, unknown>[]> = {
  child_profiles: [{ id: "child-a", display_name: "Amina <b>", created_at: "2026-10-01T00:00:00Z" }],
  mission_progress: [{ id: "run-1", mission_id: "m1", status: "complete", started_at: "2026-10-02T00:00:00Z", completed_at: "2026-10-03T00:00:00Z", missions: { title: "Six Names" } }],
  mission_evidence: [
    { id: "e1", mission_id: "m1", type: "digital", title: "My plan", description: "<script>alert(1)</script> & more", storage_path: "child-a/m1/plan.pdf", created_at: "2026-10-02T00:00:00Z" },
    { id: "e2", mission_id: "m1", type: "physical", title: "Poster", description: null, storage_path: null, created_at: "2026-10-03T00:00:00Z" },
  ],
  mission_responses: [{ progress_id: "run-1", screen_key: "s1", value: { text: "Because \"fair\" matters" }, updated_at: "2026-10-02T00:00:00Z" }],
};
function client() {
  return {
    from: (t: string) => {
      m.queries.push(t);
      const q: Record<string, unknown> = {};
      q.select = () => q; q.eq = () => q; q.order = () => q; q.in = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve({ data: tables[t], error: null });
      return q;
    },
    storage: { from: () => ({ createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://storage.test/${p}?token=t` })) }) }) },
  };
}
vi.mock("@/lib/permissions", () => ({
  requireParent: async () => ({ supabase: client(), user: { id: "parent-1" } }),
  requireOwnedChild: async (id: string) => {
    if (!m.owned.has(id)) throw new Error("not_your_child");
    return { child: { id, display_name: "Amina <b>", created_at: "2026-10-01T00:00:00Z" }, supabase: client() };
  },
}));

import { buildSavedWork } from "../saved-work";

beforeEach(() => { m.queries = []; });

describe("saved work", () => {
  it("holds each mission, its Trail and saved answers, as text that can't run", async () => {
    const { html, filename } = await buildSavedWork(null);
    expect(filename).toMatch(/^wla-saved-work-family-\d{4}-\d{2}-\d{2}\.html$/);
    expect(html).toContain("Six Names");
    expect(html).toContain("My plan");
    expect(html).toContain("made on paper");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Amina &lt;b&gt;");
    expect(html).toContain("Because &quot;fair&quot; matters");
    expect(html).toContain("https://storage.test/child-a/m1/plan.pdf");
  });

  it("one child: only a child of this parent, checked before anything is read", async () => {
    await expect(buildSavedWork("child-of-another-family")).rejects.toThrow("not_your_child");
    expect(m.queries).toEqual([]);
    const { filename } = await buildSavedWork("child-a");
    expect(filename).toMatch(/^wla-saved-work-amina-b-/);
  });
});
