import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } }) }));
vi.mock("@/lib/env", () => ({ publicEnv: { supabaseUrl: "http://db.test", supabaseAnonKey: "anon" } }));

const actions = vi.hoisted(() => {
  const ok = async () => ({ ok: true, notice: "Done." });
  return {
    saveRevisionAction: vi.fn(async () => ({ ok: true, lockVersion: 3, revisionId: "r1", contentHash: "h-saved", notice: "Saved." })),
    publishAction: vi.fn(ok),
    scheduleAction: vi.fn(ok),
    cancelScheduleAction: vi.fn(ok),
    unpublishAction: vi.fn(ok),
    archiveAction: vi.fn(ok),
    deleteArticleAction: vi.fn(ok),
    addCommentAction: vi.fn(ok),
    resolveCommentAction: vi.fn(ok),
    setMemberAction: vi.fn(ok),
    registerUploadAction: vi.fn(ok),
    createPreviewLinkAction: vi.fn(async () => ({ ok: true, previewUrl: "http://app.test/journal-preview/abc", notice: "Preview link created." })),
    revokePreviewLinkAction: vi.fn(ok),
  };
});
vi.mock("@/features/journal/actions", () => actions);
vi.mock("@/features/journal/upload-client", () => ({
  checkPickedImage: vi.fn(async () => ({ type: { mime: "image/png", ext: "png" } })),
  prepareImage: vi.fn(async () => ({ blob: new Blob(["x"]), type: { mime: "image/png", ext: "png" } })),
  uploadToStorage: vi.fn(async () => {}),
  newUploadPath: vi.fn(() => "a1/x.png"),
}));
// The editor itself is TipTap; here it is a textarea so the page logic is what is tested.
vi.mock("../studio/rich-text-editor", () => ({
  RichTextEditor: ({ value, onChange, labelId, header, readOnly }: { value: string; onChange: (v: string) => void; labelId: string; header?: React.ReactNode; readOnly?: boolean }) => (
    <div>
      {header}
      <textarea aria-labelledby={labelId} defaultValue={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
    </div>
  ),
}));

// jsdom has no <dialog> methods.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  Object.values(actions).forEach((f) => f.mockClear());
  router.push.mockClear();
});

import { UnsavedChangesProvider } from "@/components/admin/unsaved-changes";
import { ArticleStudio, type StudioProps } from "../studio/article-studio";

/*
 * The studio, rendered. These test what each person is OFFERED and what is
 * SENT; what they are ALLOWED is enforced and tested in the database
 * (scripts/journal-regression.sql).
 */
const base: StudioProps = {
  articleId: "a1",
  revision: {
    id: "r1", number: 1, state: "draft", lock_version: 2, content_hash: "h1",
    title: "First light", slug: "first-light", excerpt: "A start.", body_html: "<p>Hello.</p>",
    author_name: "Wren", category_id: null, tags: [], featured_media_id: null, featured_alt: null,
    seo_title: null, seo_description: null, canonical_url: null, original_published_at: null,
  },
  lockedReason: null,
  statusWords: "Draft",
  live: null,
  scheduled: null,
  scheduler: null,
  canPublish: true,
  isEditor: false,
  archived: false,
  everPublished: false,
  publicSiteOrigin: null,
  categories: [{ id: "c1", name: "Essays" }],
  knownTags: ["ideas", "making-things"],
  media: [],
  previewLinks: [],
  people: { members: [{ id: "u1", name: "Wren", role: "author" }], writers: [], canManage: true },
  comments: <p>No comments.</p>,
  commentCount: 0,
  history: <p>History list.</p>,
};
const studio = (over: Partial<StudioProps> = {}) =>
  render(<UnsavedChangesProvider><ArticleStudio {...base} {...over} /></UnsavedChangesProvider>);

const typeTitle = (v: string) => fireEvent.change(screen.getByLabelText("Title"), { target: { value: v } });

describe("one place for every publishing action", () => {
  it("an author sees Save draft, Share and Publish together, and the status in words", () => {
    studio();
    const bar = screen.getByRole("button", { name: "Save draft" }).closest("div")!;
    expect(within(bar).getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("there is no editorial approval anywhere (D-130): nothing to request, assign or approve", () => {
    studio();
    expect(screen.queryByText(/review/i)).toBeNull();
    expect(screen.queryByText(/approv/i)).toBeNull();
  });

  it("a collaborator who may not publish sees no Publish button", () => {
    studio({ canPublish: false });
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeInTheDocument();
  });

  it("an edited published article says so, and publishing is an update", () => {
    studio({ live: { revisionId: "r0", number: 1, slug: "first-light", publicUrl: null, studioViewHref: "/editorial/articles/a1/preview?revision=r0" }, statusWords: "Published · unpublished changes" });
    expect(screen.getByText("Published · unpublished changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Article" })).toBeInTheDocument();
    expect(screen.getByText(/Readers still see the published version/)).toBeInTheDocument();
  });
});

describe("the live link goes where readers are (the 404 fix, D-137)", () => {
  it("without a public site configured, it opens the studio's own view — never /journal here", () => {
    studio({ live: { revisionId: "r1", number: 1, slug: "first-light", publicUrl: null, studioViewHref: "/editorial/articles/a1/preview?revision=r1" } });
    const link = screen.getByRole("link", { name: "Read the published version" });
    expect(link).toHaveAttribute("href", "/editorial/articles/a1/preview?revision=r1");
    expect(document.querySelector('a[href^="/journal/"]')).toBeNull();
  });
  it("with the public site configured, it opens the article there", () => {
    studio({ live: { revisionId: "r1", number: 1, slug: "first-light", publicUrl: "https://site.test/journal/first-light", studioViewHref: "/x" } });
    expect(screen.getByRole("link", { name: /View it on the public Journal/ })).toHaveAttribute("href", "https://site.test/journal/first-light");
  });
});

describe("saving", () => {
  it("sends the lock version and revision it started from, with the settings fields", async () => {
    studio();
    typeTitle("First light, revised");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    expect(actions.saveRevisionAction).toHaveBeenCalledTimes(1);
    const fd = (actions.saveRevisionAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("lockVersion")).toBe("2");
    expect(fd.get("revisionId")).toBe("r1");
    expect(fd.get("title")).toBe("First light, revised");
    // Settings live in a side panel but belong to the same form.
    expect(fd.get("category_id")).toBe("");
    expect(fd.has("slug") && fd.has("tags") && fd.has("seo_title")).toBe(true);
  });

  it("after a successful save it says Saved — new lock and revision are bookkeeping, not unsaved changes", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ ok: true, lockVersion: 7, revisionId: "r9", contentHash: "h9", notice: "Saved." } as never);
    studio();
    typeTitle("Changed");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    expect(await screen.findByText(/^Draft saved at/)).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("a new article's web address follows its title until set by hand", async () => {
    studio({ revision: { ...base.revision, title: "", slug: "" } });
    typeTitle("A Quiet Morning");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    const fd = (actions.saveRevisionAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("slug")).toBe("a-quiet-morning");
  });

  it("the first save of an edit to a published article says a new draft was made", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ ok: true, lockVersion: 1, revisionId: "r2", contentHash: "h2", startedNewVersion: true, notice: "Saved as a new draft. Readers still see the published version until you publish this one." } as never);
    studio({ live: { revisionId: "r1", number: 1, slug: "first-light", publicUrl: null, studioViewHref: "/x" } });
    typeTitle("Edited");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    expect(await screen.findByText(/Saved as a new draft/)).toBeInTheDocument();
    expect((document.querySelector('input[name="revisionId"]') as HTMLInputElement).value).toBe("r2");
  });

  it("a conflict keeps the author's text and names who saved", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ error: "x", conflict: { by: "Eda", at: "2026-10-15T10:00:00Z", lockVersion: 5 } } as never);
    studio();
    typeTitle("Mine");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    expect(await screen.findByText(/Someone else saved this article/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Mine");
    fireEvent.click(screen.getByRole("button", { name: /Keep mine/ }));
    expect((document.querySelector('input[name="lockVersion"]') as HTMLInputElement).value).toBe("5");
  });
});

describe("publishing and scheduling (one review, no approval)", () => {
  it("publishes the saved version directly", async () => {
    studio();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish Article" })); });
    const fd = (actions.publishAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("revisionId")).toBe("r1");
    expect(fd.get("contentHash")).toBe("h1");
    expect(actions.saveRevisionAction).not.toHaveBeenCalled();
  });

  it("unsaved changes are saved first, then exactly that saved version is published", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ ok: true, lockVersion: 3, revisionId: "r1", contentHash: "h-new", notice: "Saved." } as never);
    studio();
    typeTitle("Changed");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByText(/Your unsaved changes are saved first/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish Article" })); });
    expect(actions.saveRevisionAction).toHaveBeenCalledTimes(1);
    const fd = (actions.publishAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("contentHash")).toBe("h-new");
  });

  it("if the save fails, nothing is published", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ error: "That didn't save." } as never);
    studio();
    typeTitle("Changed");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish Article" })); });
    expect(actions.publishAction).not.toHaveBeenCalled();
  });

  it("says what is missing instead of offering to publish", () => {
    studio({ revision: { ...base.revision, title: "", slug: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give it a title.");
    expect(screen.getByRole("button", { name: "Publish Article" })).toBeDisabled();
  });

  it("schedules in UK time, previewed in words, sent as the wall time", async () => {
    studio();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    fireEvent.click(screen.getByLabelText("At a later time"));
    fireEvent.change(screen.getByLabelText(/Date and time — UK time/), { target: { value: "2026-12-01T09:30" } });
    expect(screen.getByText(/^= /)).toHaveTextContent("09:30");
    expect(screen.getByText(/publishes by itself at that moment/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Schedule Article" })); });
    const fd = (actions.scheduleAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("atLocal")).toBe("2026-12-01T09:30");
  });

  it("an already-published version with no changes has nothing to publish", () => {
    studio({ live: { revisionId: "r1", number: 1, slug: "first-light", publicUrl: null, studioViewHref: "/x" }, statusWords: "Published" });
    fireEvent.click(screen.getByRole("button", { name: "Update Article" }));
    expect(screen.getByText(/This version is already published/)).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Update Article" })).toBeNull();
  });

  it("a scheduled article is locked, says when, and offers cancelling", () => {
    studio({ scheduled: { at: "2026-12-01T09:30:00Z", by: "Wren" }, lockedReason: "Scheduled to publish… Cancel the schedule to make changes." });
    expect(screen.getByText(/to publish automatically on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel the schedule/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
  });
});

describe("sharing a preview", () => {
  it("makes a view-only link, shown once, and keeps editing separate", async () => {
    studio({ previewLinks: [{ id: "l1", createdAt: "2026-10-15T08:00:00Z", expiresAt: "2026-11-14T08:00:00Z", by: "Wren" }] });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const dlg = screen.getByRole("dialog", { name: "Share a preview" });
    expect(within(dlg).getByText(/View only/)).toBeInTheDocument();
    expect(within(dlg).getByText(/A preview link never lets anyone edit/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Create a preview link" })); });
    expect(within(dlg).getByLabelText("Your preview link")).toHaveValue("http://app.test/journal-preview/abc");
    expect(within(dlg).getByText(/shown only once/)).toBeInTheDocument();
    expect(within(dlg).getByRole("heading", { name: "Who can edit" })).toBeInTheDocument();
  });
});

describe("headings, words and focus", () => {
  it("headings never skip a level, with every panel and dialog open", () => {
    studio({ live: { revisionId: "r1", number: 1, slug: "s", publicUrl: null, studioViewHref: "/x" }, isEditor: true });
    fireEvent.click(screen.getByRole("button", { name: "Article Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4")).filter((h) => !h.closest("[hidden]")).map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  });

  it("headings never skip a level with the review open", () => {
    studio({ live: { revisionId: "r1", number: 1, slug: "s", publicUrl: null, studioViewHref: "/x" }, isEditor: true });
    fireEvent.click(screen.getByRole("button", { name: "Update Article" }));
    const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4")).filter((h) => !h.closest("[hidden]")).map((h) => Number(h.tagName[1]));
    expect(levels).toContain(3);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  });

  it("on a smaller screen the settings open with focus on their heading and close with Escape", async () => {
    studio();
    const toggle = screen.getByRole("button", { name: "Article Settings" });
    fireEvent.click(toggle);
    const heading = screen.getByRole("heading", { name: "Article Settings" });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.keyDown(heading, { key: "Escape" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
  });

  it("closing them returns focus to the button that opened them (Escape and Close)", async () => {
    studio();
    const toggle = screen.getByRole("button", { name: "Article Settings" });
    const heading = () => screen.getByRole("heading", { name: "Article Settings" });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(heading()).toHaveFocus());
    fireEvent.keyDown(heading(), { key: "Escape" });
    await waitFor(() => expect(toggle).toHaveFocus());

    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(heading()).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Close article settings" }));
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it("archive and delete stay out of the writing flow, inside Article Settings, for editors only", () => {
    studio({ isEditor: false });
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    cleanup();
    studio({ isEditor: true });
    const settings = screen.getByRole("complementary", { name: "Article Settings" });
    expect(within(settings).getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: "Delete this draft" })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ D-147 --
const sidebar = () => within(screen.getByRole("complementary", { name: "Article Settings" }));
const review = () => within(screen.getByRole("dialog"));
const openReview = (name = "Publish") => fireEvent.click(screen.getByRole("button", { name }));
const confirm = async (name = "Publish Article") => { await act(async () => { fireEvent.click(review().getByRole("button", { name })); }); };
const saveDraft = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); }); };
const lastSave = () => (actions.saveRevisionAction.mock.calls.at(-1) as unknown as [unknown, FormData])[1];
const live = { revisionId: "r1", number: 1, slug: "first-light", publicUrl: null, studioViewHref: "/x" };
const withImage = { ...base.revision, featured_media_id: "11111111-1111-4111-8111-111111111111", featured_alt: "A lamp" };

describe("Article Settings", () => {
  it("is clearly headed, and holds every setting without opening anything", () => {
    studio();
    const s = sidebar();
    expect(s.getByRole("heading", { name: "Article Settings" })).toBeInTheDocument();
    for (const name of ["Web address", "Category", "Tags", "Excerpt", "First published (if elsewhere)", "Search title", "Search description", "Canonical address"]) {
      expect(s.getByLabelText(name)).toBeInTheDocument();
    }
    expect(s.getByRole("group", { name: "Featured image" })).toBeInTheDocument();
  });

  it("every setting is saved once, from one hidden field, keeping its existing value", async () => {
    studio({ revision: { ...withImage, category_id: "c1", tags: ["ideas"], seo_title: "S", seo_description: "D", canonical_url: "https://x.test/a", original_published_at: "2024-02-03T12:00:00Z" } });
    await saveDraft();
    const fd = lastSave();
    for (const k of ["slug", "excerpt", "author_name", "category_id", "tags", "featured_media_id", "featured_alt", "seo_title", "seo_description", "canonical_url", "original_published_at"]) {
      expect(fd.getAll(k)).toHaveLength(1);
    }
    expect(Object.fromEntries(fd)).toMatchObject({
      slug: "first-light", excerpt: "A start.", author_name: "Wren", category_id: "c1", tags: "ideas",
      featured_media_id: withImage.featured_media_id, featured_alt: "A lamp", seo_title: "S", seo_description: "D",
      canonical_url: "https://x.test/a", original_published_at: "2024-02-03",
    });
  });

  it("changing a setting counts as an unsaved change", () => {
    studio();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(sidebar().getByLabelText("Search title"), { target: { value: "Found by this" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("the web address can be edited, and stops following the title", async () => {
    studio();
    fireEvent.change(sidebar().getByLabelText("Web address"), { target: { value: "new-address" } });
    typeTitle("Something else");
    await saveDraft();
    expect(lastSave().get("slug")).toBe("new-address");
  });

  it("a category can be chosen and cleared", async () => {
    studio();
    fireEvent.change(sidebar().getByLabelText("Category"), { target: { value: "c1" } });
    await saveDraft();
    expect(lastSave().get("category_id")).toBe("c1");
    fireEvent.change(sidebar().getByLabelText("Category"), { target: { value: "" } });
    await saveDraft();
    expect(lastSave().get("category_id")).toBe("");
  });

  it("tags are added by Enter, by comma, on leaving the field and from suggestions, and removed", async () => {
    studio({ revision: { ...base.revision, tags: ["old-tag"] } });
    const s = sidebar();
    const input = s.getByLabelText("Tags");
    fireEvent.change(input, { target: { value: "Quiet Rooms" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "one, two," } });
    fireEvent.change(input, { target: { value: "left behind" } });
    fireEvent.blur(input);
    fireEvent.click(s.getByRole("button", { name: "Add tag ideas" }));
    fireEvent.click(s.getByRole("button", { name: "Remove tag old tag" }));
    await saveDraft();
    expect(lastSave().get("tags")).toBe("quiet-rooms, one, two, left-behind, ideas");
  });

  it("a featured image can be added, and asks for its own description", async () => {
    actions.registerUploadAction.mockResolvedValueOnce({ ok: true, mediaId: "22222222-2222-4222-8222-222222222222", mediaUrl: "/api/journal/media/x" } as never);
    studio();
    const s = sidebar();
    expect(s.getByText(/No featured image/)).toBeInTheDocument();
    await act(async () => { fireEvent.change(s.getByLabelText("Choose a featured image file"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } }); });
    expect(await s.findByRole("img", { name: "The chosen featured image" })).toHaveAttribute("src", "/api/journal/media/22222222-2222-4222-8222-222222222222");
    expect(s.getByLabelText("Image description")).toHaveValue("");
    fireEvent.change(s.getByLabelText("Image description"), { target: { value: "A window" } });
    await saveDraft();
    expect(lastSave().get("featured_media_id")).toBe("22222222-2222-4222-8222-222222222222");
    expect(lastSave().get("featured_alt")).toBe("A window");
  });

  it("a draft saves with a featured image and no description, without complaint", async () => {
    studio({ revision: { ...withImage, featured_alt: "" } });
    typeTitle("Still working on it");
    await saveDraft();
    expect(lastSave().get("featured_media_id")).toBe(withImage.featured_media_id);
    expect(lastSave().get("featured_alt")).toBe("");
    expect(await screen.findByText(/^Draft saved at/)).toBeInTheDocument();
    expect(sidebar().getByLabelText("Image description")).not.toHaveAttribute("aria-invalid");
  });

  it("a featured image can be replaced from the article's images, taking that image's description", async () => {
    studio({ revision: withImage, media: [{ id: "33333333-3333-4333-8333-333333333333", alt: "A door" }] });
    fireEvent.click(sidebar().getByRole("button", { name: /Use A door/ }));
    await saveDraft();
    expect(lastSave().get("featured_media_id")).toBe("33333333-3333-4333-8333-333333333333");
    expect(lastSave().get("featured_alt")).toBe("A door");
  });

  it("a featured image can be removed", async () => {
    studio({ revision: withImage });
    fireEvent.click(sidebar().getByRole("button", { name: "Remove image" }));
    expect(sidebar().getByText(/No featured image/)).toBeInTheDocument();
    await saveDraft();
    expect(lastSave().get("featured_media_id")).toBe("");
    expect(lastSave().get("featured_alt")).toBe("");
  });

  it("a refused setting is marked at the field, and opens the settings on a smaller screen", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ fieldErrors: { slug: "Another article already uses that URL slug." } } as never);
    studio();
    await saveDraft();
    expect(sidebar().getByLabelText("Web address")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Article Settings" })).toHaveAttribute("aria-expanded", "true");
  });

  it("a read-only person sees the settings but can't change them", () => {
    studio({ lockedReason: "You can read this article." });
    expect(sidebar().getByLabelText("Web address")).toBeDisabled();
    expect(sidebar().getByLabelText("Tags")).toBeDisabled();
  });
});

describe("the review before publishing", () => {
  it("opening it publishes and saves nothing, and shows what is about to go live", () => {
    studio({ revision: { ...withImage, category_id: "c1", tags: ["ideas"] } });
    openReview();
    expect(screen.getByRole("heading", { name: "Review Before Publishing" })).toBeInTheDocument();
    expect(actions.publishAction).not.toHaveBeenCalled();
    expect(actions.saveRevisionAction).not.toHaveBeenCalled();
    const r = review();
    expect(r.getByLabelText("Title")).toHaveValue("First light");
    expect(r.getByLabelText("Excerpt")).toHaveValue("A start.");
    expect(r.getByRole("img", { name: "The chosen featured image" })).toBeInTheDocument();
    expect(r.getByLabelText("Web address")).toHaveValue("first-light");
    expect(r.getByLabelText("Category")).toHaveValue("c1");
    expect(r.getByRole("list", { name: "Tags on this article" })).toHaveTextContent("ideas");
    expect(r.getByRole("button", { name: "Back to Editing" })).toBeInTheDocument();
    expect(r.getByRole("button", { name: "Publish Article" })).toBeEnabled();
  });

  it("changes made in the review are the editor's own: one value, kept after going back", async () => {
    studio();
    openReview();
    const r = review();
    fireEvent.change(r.getByLabelText("Title"), { target: { value: "Second light" } });
    fireEvent.change(r.getByLabelText("Excerpt"), { target: { value: "Reworded." } });
    fireEvent.change(r.getByLabelText("Web address"), { target: { value: "second-light" } });
    fireEvent.change(r.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.change(r.getByLabelText("Tags"), { target: { value: "fresh" } });
    fireEvent.keyDown(r.getByLabelText("Tags"), { key: "Enter" });
    fireEvent.click(r.getByRole("button", { name: "Back to Editing" }));

    expect(screen.queryByRole("heading", { name: "Review Before Publishing" })).toBeNull();
    expect(actions.publishAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Title")).toHaveValue("Second light");
    expect(screen.getByLabelText(/Subtitle/)).toHaveValue("Reworded.");
    expect(sidebar().getByLabelText("Web address")).toHaveValue("second-light");
    expect(sidebar().getByLabelText("Category")).toHaveValue("c1");
    expect(sidebar().getByText("fresh")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    openReview();
    expect(review().getByLabelText("Title")).toHaveValue("Second light");
    await confirm();
    const fd = lastSave();
    expect(fd.getAll("slug")).toEqual(["second-light"]);
    expect(fd.get("title")).toBe("Second light");
    expect(fd.get("tags")).toBe("fresh");
  });

  it("the sidebar's changes appear in the review", () => {
    studio();
    fireEvent.change(sidebar().getByLabelText("Web address"), { target: { value: "from-the-side" } });
    openReview();
    expect(review().getByLabelText("Web address")).toHaveValue("from-the-side");
  });

  it("missing details stop publishing, are explained and marked, and lead to the field", () => {
    studio({ revision: { ...base.revision, title: "", slug: "" } });
    openReview();
    const r = review();
    expect(r.getByRole("alert")).toHaveTextContent("Give it a title.");
    expect(r.getByRole("alert")).toHaveTextContent("It needs a web address.");
    expect(r.getByRole("button", { name: "Publish Article" })).toBeDisabled();
    expect(r.getByLabelText("Title")).toHaveAttribute("aria-invalid", "true");
    expect(r.getByLabelText("Web address")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(r.getAllByRole("button", { name: "Go to this field" })[0]);
    expect(r.getByLabelText("Title")).toHaveFocus();
    fireEvent.change(r.getByLabelText("Title"), { target: { value: "Named" } });
    expect(r.getByLabelText("Web address")).toHaveValue("named");
    expect(r.getByRole("button", { name: "Publish Article" })).toBeEnabled();
    expect(actions.publishAction).not.toHaveBeenCalled();
  });

  it("an article with no text sends you back to the editor", async () => {
    studio({ revision: { ...base.revision, body_html: "<p></p>" } });
    openReview();
    expect(review().getByRole("alert")).toHaveTextContent("has no text");
    fireEvent.click(review().getByRole("button", { name: "Go to the article" }));
    expect(screen.queryByRole("heading", { name: "Review Before Publishing" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Article text")).toHaveFocus());
  });

  it("a featured image without a description is marked; image, category and tags stay optional", () => {
    studio({ revision: { ...withImage, featured_alt: "" } });
    openReview();
    expect(review().getByRole("button", { name: "Publish Article" })).toBeDisabled();
    expect(review().getByLabelText("Image description")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(review().getByRole("button", { name: "Remove image" }));
    expect(review().getByRole("button", { name: "Publish Article" })).toBeEnabled();
  });
});

describe("after pressing Publish Article", () => {
  it("publishes through the existing action, and moves on only once the server has said yes", async () => {
    let answer: (v: { ok: boolean }) => void = () => {};
    actions.publishAction.mockImplementationOnce((() => new Promise((res) => { answer = res; })) as never);
    studio();
    openReview();
    await confirm();
    expect(actions.publishAction).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    expect(review().getByRole("button", { name: /Publishing/ })).toBeDisabled();
    expect(review().getByRole("button", { name: "Back to Editing" })).toBeDisabled();
    await act(async () => { answer({ ok: true }); });
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/editorial?notice=published&article=a1");
  });

  it("repeated clicks publish once", async () => {
    actions.publishAction.mockImplementationOnce((() => new Promise(() => {})) as never);
    studio();
    openReview();
    const go = review().getByRole("button", { name: "Publish Article" });
    await act(async () => { fireEvent.click(go); fireEvent.click(go); fireEvent.click(go); });
    expect(actions.publishAction).toHaveBeenCalledTimes(1);
  });

  it("a refusal keeps everything, claims nothing, and can be tried again", async () => {
    actions.publishAction.mockResolvedValueOnce({ error: "You don't have permission to do that." } as never);
    studio();
    typeTitle("Kept");
    openReview();
    await confirm();
    expect(router.push).not.toHaveBeenCalled();
    expect(review().getByRole("alert")).toHaveTextContent("You don't have permission to do that.");
    expect(review().getByLabelText("Title")).toHaveValue("Kept");
    expect(screen.queryByText(/published successfully/)).toBeNull();
    await confirm();
    expect(actions.publishAction).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/editorial?notice=published&article=a1");
  });

  it("a dropped connection says it can't tell, rather than that nothing happened", async () => {
    actions.publishAction.mockRejectedValueOnce(new Error("offline"));
    studio();
    openReview();
    await confirm();
    expect(router.push).not.toHaveBeenCalled();
    expect(review().getByRole("alert")).toHaveTextContent(/can't say this went through/);
    expect(review().getByRole("button", { name: "Publish Article" })).toBeEnabled();
  });

  it("a web address another article uses is marked at that field", async () => {
    actions.publishAction.mockResolvedValueOnce({ fieldErrors: { slug: "Another article already uses that URL slug." } } as never);
    studio();
    openReview();
    await confirm();
    expect(review().getByLabelText("Web address")).toHaveAttribute("aria-invalid", "true");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("if the server refuses a missing image description, the field is marked and it stays", async () => {
    actions.publishAction.mockResolvedValueOnce({ fieldErrors: { featured_alt: "Describe the featured image for people who can't see it." } } as never);
    studio({ revision: withImage });
    openReview();
    await confirm();
    expect(review().getByLabelText("Image description")).toHaveAttribute("aria-invalid", "true");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("if saving first is refused, nothing is published and the field is marked", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ fieldErrors: { slug: "Another article already uses that URL slug." } } as never);
    studio();
    typeTitle("Changed");
    openReview();
    await confirm();
    expect(actions.publishAction).not.toHaveBeenCalled();
    expect(review().getByLabelText("Web address")).toHaveAttribute("aria-invalid", "true");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("scheduling goes back to the list too, and publishes nothing now", async () => {
    studio();
    openReview();
    fireEvent.click(review().getByLabelText("At a later time"));
    fireEvent.change(review().getByLabelText(/Date and time — UK time/), { target: { value: "2026-12-01T09:30" } });
    await confirm("Schedule Article");
    expect(actions.publishAction).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/editorial?notice=scheduled&article=a1");
  });
});

describe("an article that is already published", () => {
  const edited = { live, statusWords: "Published", everPublished: true };

  it("says it's an update, and the final action says Update Article", () => {
    studio(edited);
    typeTitle("Better");
    openReview("Update Article");
    expect(screen.getByRole("heading", { name: "Review Before Updating" })).toBeInTheDocument();
    expect(review().getByText(/updating an article that's already published/)).toBeInTheDocument();
    expect(review().getByRole("button", { name: "Update Article" })).toBeEnabled();
    expect(review().queryByRole("button", { name: "Publish Article" })).toBeNull();
  });

  it("publishes the newly saved version and reports an update", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ ok: true, lockVersion: 1, revisionId: "r2", contentHash: "h2", startedNewVersion: true } as never);
    studio(edited);
    typeTitle("Better");
    openReview("Update Article");
    await confirm("Update Article");
    const fd = (actions.publishAction.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("revisionId")).toBe("r2");
    expect(fd.get("contentHash")).toBe("h2");
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/editorial?notice=updated&article=a1");
  });

  it("Save draft doesn't touch what is live: no publish, no unpublish, and it stays here", async () => {
    studio(edited);
    typeTitle("Better");
    await saveDraft();
    expect(actions.saveRevisionAction).toHaveBeenCalledTimes(1);
    expect(actions.publishAction).not.toHaveBeenCalled();
    expect(actions.unpublishAction).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("an article that was unpublished is published again, not updated", () => {
    studio({ everPublished: true });
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });
});

describe("Save draft stays separate", () => {
  it("saves without opening the review or publishing, says so, and stays on the page", async () => {
    studio();
    typeTitle("Still a draft");
    await saveDraft();
    expect(screen.queryByRole("heading", { name: "Review Before Publishing" })).toBeNull();
    expect(actions.publishAction).not.toHaveBeenCalled();
    expect(actions.scheduleAction).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(await screen.findByText(/^Draft saved at/)).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("a failed save keeps the text and says it's unsaved", async () => {
    actions.saveRevisionAction.mockResolvedValueOnce({ error: "That didn't save." } as never);
    studio();
    typeTitle("Mine");
    await saveDraft();
    expect(screen.getByLabelText("Title")).toHaveValue("Mine");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
