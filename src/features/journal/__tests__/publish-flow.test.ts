import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishProblems } from "../publish-check";
import { publishNotice } from "../publish-notice";

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  liveRevision: null as string | null,
  revision: { featured_media_id: null, featured_alt: null } as { featured_media_id: string | null; featured_alt: string | null },
  revisionError: null as { message: string } | null,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => db.revalidated.push(p) }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logAccessDenied: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/permissions/journal", () => ({
  requireJournalStaff: async () => ({
    supabase: {
      rpc: db.rpc,
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "journal_revisions"
                ? { data: db.revisionError ? null : { id: "r1", article_id: "a1", state: "draft", ...db.revision }, error: db.revisionError }
                : { data: { live_revision_id: db.liveRevision, working_revision_id: "r1" }, error: null },
          }),
        }),
      }),
    },
  }),
}));

import { publishAction, saveRevisionAction, scheduleAction } from "../actions";

const form = () => {
  const fd = new FormData();
  fd.set("articleId", "a1");
  fd.set("revisionId", "r1");
  fd.set("contentHash", "h1");
  return fd;
};

beforeEach(() => {
  db.rpc.mockReset();
  db.liveRevision = null;
  db.revision = { featured_media_id: null, featured_alt: null };
  db.revisionError = null;
  db.revalidated = [];
});

describe("publishAction", () => {
  it("publishes exactly the revision and hash it was given", async () => {
    db.rpc.mockResolvedValue({ error: null });
    await expect(publishAction({}, form())).resolves.toMatchObject({ ok: true });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("journal_publish", { p_revision: "r1", p_expected_hash: "h1" });
    expect(db.revalidated).toContain("/editorial");
  });

  it("a retry after a lost answer counts as success when that version is live", async () => {
    db.rpc.mockResolvedValue({ error: { message: "not_publishable" } });
    db.liveRevision = "r1";
    await expect(publishAction({}, form())).resolves.toMatchObject({ ok: true });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it("not publishable, and that version isn't live, stays a refusal", async () => {
    db.rpc.mockResolvedValue({ error: { message: "not_publishable" } });
    db.liveRevision = "r-other";
    const r = await publishAction({}, form());
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/can't be published/);
  });

  it("a web address problem is reported against that field", async () => {
    db.rpc.mockResolvedValue({ error: { message: "slug_taken" } });
    await expect(publishAction({}, form())).resolves.toEqual({ fieldErrors: { slug: "Another article already uses that URL slug." } });
  });

  it("an unexpected database error never reaches the person", async () => {
    db.rpc.mockResolvedValue({ error: { message: 'relation "secret_table" does not exist' } });
    const r = await publishAction({}, form());
    expect(r.error).toBe("That didn't work. Please try again.");
    expect(db.revalidated).toEqual([]);
  });
});

describe("a featured image's description: not needed for a draft, needed to go live", () => {
  const IMAGE = "22222222-2222-4222-8222-222222222222";
  const REFUSED = { fieldErrors: { featured_alt: "Describe the featured image for people who can't see it." } };
  const schedule = () => { const fd = form(); fd.set("atLocal", "2030-12-01T09:30"); return fd; };

  it("a draft saves with an image and no description", async () => {
    db.rpc.mockImplementation(async (name: string) => (name === "journal_save_revision"
      ? { data: [{ outcome: "saved", lock_version: 2, content_hash: "h2" }], error: null }
      : { data: [], error: null }));
    const fd = form();
    fd.set("lockVersion", "1");
    fd.set("featured_media_id", IMAGE);
    fd.set("featured_alt", "");
    const r = await saveRevisionAction({}, fd);
    expect(r).toMatchObject({ ok: true });
    const saved = db.rpc.mock.calls.find(([name]) => name === "journal_save_revision")![1];
    expect(saved.p_fields).toMatchObject({ featured_media_id: IMAGE, featured_alt: "" });
  });

  it.each([null, "", "   "])("publishing what was saved with description %j is refused, and nothing is asked of the database", async (alt) => {
    db.revision = { featured_media_id: IMAGE, featured_alt: alt };
    await expect(publishAction({}, form())).resolves.toEqual(REFUSED);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("scheduling it is refused the same way", async () => {
    db.revision = { featured_media_id: IMAGE, featured_alt: null };
    await expect(scheduleAction({}, schedule())).resolves.toEqual(REFUSED);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("with a description, both go ahead", async () => {
    db.revision = { featured_media_id: IMAGE, featured_alt: "A lamp" };
    db.rpc.mockResolvedValue({ error: null });
    await expect(publishAction({}, form())).resolves.toMatchObject({ ok: true });
    await expect(scheduleAction({}, schedule())).resolves.toMatchObject({ ok: true });
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual(["journal_publish", "journal_schedule"]);
  });

  it("no image needs no description", async () => {
    db.rpc.mockResolvedValue({ error: null });
    await expect(publishAction({}, form())).resolves.toMatchObject({ ok: true });
  });

  it("if the check can't be made, nothing is published", async () => {
    db.revisionError = { message: "connection reset" };
    const r = await publishAction({}, form());
    expect(r.error).toBe("That didn't work. Please try again.");
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe("publishProblems uses the existing rules and adds none", () => {
  const ok = { title: "T", body: "<p>Text</p>", slug: "t", featured: "", featuredAlt: "", pendingUploads: 0 };
  const fields = (over: Partial<typeof ok>) => publishProblems({ ...ok, ...over }).map((p) => p.field);

  it("no image, category, tags or excerpt is fine", () => expect(fields({})).toEqual([]));
  it("needs a title", () => expect(fields({ title: "  " })).toEqual(["title"]));
  it("needs a web address, and a valid one", () => {
    expect(fields({ slug: "" })).toEqual(["slug"]);
    expect(fields({ slug: "Not Valid" })).toEqual(["slug"]);
    expect(fields({ slug: "search" })).toEqual(["slug"]);
  });
  it("needs text, as the database does: an image alone isn't enough", () => {
    expect(fields({ body: "<p></p>" })).toEqual(["body"]);
    expect(fields({ body: "<p>&nbsp;</p>" })).toEqual(["body"]);
    expect(fields({ body: '<figure><img src="/x" alt="y"></figure>' })).toEqual(["body"]);
  });
  it("an image needs a description, as saving does", () => {
    expect(fields({ featured: "m1" })).toEqual(["featured_alt"]);
    expect(fields({ featured: "m1", featuredAlt: "A lamp" })).toEqual([]);
  });
  it("waits for uploads", () => expect(fields({ pendingUploads: 1 })).toEqual(["uploads"]));
});

describe("publishNotice believes the row, not the address", () => {
  const liveRow = {
    article: { id: "a1", live_revision_id: "r1", scheduled_for: null },
    live: { id: "r1", title: "First light", slug: "first-light" },
    working: { title: "First light" },
  };
  const draftRow = { article: { id: "a2", live_revision_id: null, scheduled_for: null }, live: null, working: { title: "Draft" } };

  it("published: the agreed words, and a link that works", () => {
    const n = publishNotice("published", "a1", [liveRow]);
    expect(n?.message).toBe("Article published successfully. Your article is now live on the Journal.");
    expect(n?.title).toBe("First light");
    expect(n?.link).toEqual({ href: "/editorial/articles/a1/preview?revision=r1", label: "Read the published article", external: false });
  });

  it("links to the public Journal when it's configured", () => {
    vi.stubEnv("NEXT_PUBLIC_JOURNAL_SITE_URL", "https://site.test");
    expect(publishNotice("published", "a1", [liveRow])?.link).toEqual({ href: "https://site.test/journal/first-light", label: "View on the Journal", external: true });
    vi.unstubAllEnvs();
  });

  it("updated says updated", () => expect(publishNotice("updated", "a1", [liveRow])?.message).toMatch(/^Article updated successfully/));

  it("says nothing if the article isn't actually live", () => {
    expect(publishNotice("published", "a2", [draftRow])).toBeNull();
    expect(publishNotice("updated", "a2", [draftRow])).toBeNull();
  });

  it("says nothing for an article this person can't see, or any other notice", () => {
    expect(publishNotice("published", "nope", [liveRow])).toBeNull();
    expect(publishNotice("deleted", "a1", [liveRow])).toBeNull();
    expect(publishNotice(undefined, undefined, [liveRow])).toBeNull();
  });

  it("scheduled only if it is", () => {
    expect(publishNotice("scheduled", "a1", [liveRow])).toBeNull();
    const row = { ...draftRow, article: { ...draftRow.article, scheduled_for: "2026-12-01T09:30:00Z" } };
    expect(publishNotice("scheduled", "a2", [row])?.message).toMatch(/It will publish automatically on/);
  });
});
