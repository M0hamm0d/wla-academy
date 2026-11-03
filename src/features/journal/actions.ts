"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { AccessError } from "@/lib/permissions";
import { requireJournalStaff } from "@/lib/permissions/journal";
import { logAccessDenied, logWarn } from "@/lib/observability/logger";
import type { Json } from "@/types/database";
import { mediaUrl, normaliseTags, sanitizeArticleHtml, slugify, slugProblem } from "./content";
import { journalErrorCode, journalErrorMessage } from "./errors";
import { FEATURED_ALT_REQUIRED } from "./publish-check";
import { removeUnusedMedia } from "./media-cleanup";
import { imageProblem, isArticleMediaPath, sniffImage } from "./media";
import { formatLondon, londonWallTimeToUtc } from "./time";

/**
 * JOURNAL STUDIO ACTIONS (D-123 … D-133).
 *
 * Each action: (1) checks the caller is Journal staff — for a clear message,
 * not for security; (2) validates and SANITISES input; (3) calls one journal_*
 * function with the caller's own session. Step 3 is the control: the database
 * re-checks the role, the article membership, the revision state and the
 * content hash, whatever this file does (scripts/journal-regression.sql).
 */

export type JournalState = {
  ok?: boolean;
  error?: string;
  notice?: string;
  fieldErrors?: Record<string, string>;
  /** A stale save (D-128): who saved last, and when. Their text stays in the form. */
  conflict?: { by: string | null; at: string; lockVersion: number };
  lockVersion?: number;
  /** The revision a save landed in — new when an edit to a published article started a new draft. */
  revisionId?: string;
  contentHash?: string;
  startedNewVersion?: boolean;
  mediaId?: string;
  mediaUrl?: string;
  /** A new preview link: shown ONCE (only its hash is stored, D-134). */
  previewUrl?: string;
};

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

async function staff() {
  try {
    return await requireJournalStaff();
  } catch (e) {
    if (e instanceof AccessError) {
      logAccessDenied("journal_action", { reason: e.reason });
      return null;
    }
    throw e;
  }
}

function refresh(articleId?: string) {
  revalidatePath("/editorial");
  if (articleId) revalidatePath(`/editorial/articles/${articleId}`);
  revalidatePath("/journal", "layout");
}

function refused(error: { message: string }, op: string): JournalState {
  if (!journalErrorCode(error)) logWarn("journal_action_failed", { op, reason: error.message });
  return { error: journalErrorMessage(error) };
}

const NOT_STAFF: JournalState = { error: "You don't have access to the Journal studio." };

// ------------------------------------------------------------- articles --
/** "New article": an untitled draft, opened straight in the editor (D-136). */
export async function newArticleAction(): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  if (!s.caps.canWrite) return { error: "You can't start articles." };
  const { data, error } = await s.supabase.rpc("journal_create_article", { p_title: "", p_slug: "" });
  if (error) {
    // Every failed create is recorded, including expected refusals (bb70c43).
    logWarn("journal_create_article_failed", { code: journalErrorCode(error) ?? null, reason: error.message });
    return refused(error, "create");
  }
  refresh();
  redirect(`/editorial/articles/${data}`);
}

const revisionSchema = z.object({
  title: z.string().trim().max(200, "Keep the title under 200 characters."),
  slug: z.string().trim(),
  excerpt: z.string().trim().max(600, "Keep the excerpt under 600 characters."),
  body_html: z.string().max(400000, "The article is too long to save in one piece."),
  author_name: z.string().trim().max(120),
  category_id: z.union([z.literal(""), z.uuid()]),
  tags: z.string().max(1000),
  featured_media_id: z.union([z.literal(""), z.uuid()]),
  featured_alt: z.string().trim().max(500),
  seo_title: z.string().trim().max(200, "Keep the search title under 200 characters."),
  seo_description: z.string().trim().max(320, "Keep the search description under 320 characters."),
  canonical_url: z.union([z.literal(""), z.url({ protocol: /^https$/, message: "Use a full https:// address." })]),
  original_published_at: z.union([z.literal(""), z.iso.date("Use a date.")]),
});

export async function saveRevisionAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  const revisionId = str(fd, "revisionId");
  const articleId = str(fd, "articleId");
  const lock = Number(str(fd, "lockVersion"));
  const parsed = revisionSchema.safeParse(Object.fromEntries(Object.keys(revisionSchema.shape).map((k) => [k, str(fd, k)])));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message;
    return { fieldErrors };
  }
  const d = parsed.data;
  if (d.slug) {
    const problem = slugProblem(d.slug);
    if (problem) return { fieldErrors: { slug: problem } };
  }

  const fields = {
    title: d.title,
    slug: d.slug,
    excerpt: d.excerpt,
    // Sanitised HERE, before it is stored; and again whenever it is rendered.
    body_html: sanitizeArticleHtml(d.body_html),
    author_name: d.author_name,
    category_id: d.category_id,
    tags: normaliseTags(d.tags),
    featured_media_id: d.featured_media_id,
    featured_alt: d.featured_alt,
    seo_title: d.seo_title,
    seo_description: d.seo_description,
    canonical_url: d.canonical_url,
    original_published_at: d.original_published_at ? `${d.original_published_at}T12:00:00Z` : "",
  };
  // Editing a published article (D-137): the live version is never changed in
  // place. The first save starts a new draft from it; readers keep the live
  // version until that draft is published. A version left in a review
  // (no longer offered, D-130) simply returns to draft.
  const target = await editableTarget(s.supabase, articleId, revisionId, lock);
  if ("error" in target) return target.error;
  const { data, error } = await s.supabase.rpc("journal_save_revision", {
    p_revision: target.id,
    p_expected_lock: target.lock,
    p_fields: fields as unknown as Json,
  });
  if (error) {
    const code = journalErrorCode(error);
    if (code === "slug_taken" || code === "slug_invalid") return { fieldErrors: { slug: journalErrorMessage(error) } };
    return refused(error, "save");
  }
  const row = data?.[0];
  if (!row) return { error: "That didn't save. Please try again." };
  if (row.outcome === "conflict") {
    const people = await s.supabase.rpc("journal_staff_directory", {});
    const who = (people.data ?? []).find((p) => p.profile_id === row.updated_by);
    return {
      error: "Someone else saved this version while you were editing. Your text is still here — compare it with theirs before saving again.",
      conflict: { by: who ? who.name || who.email : null, at: row.updated_at, lockVersion: row.lock_version },
    };
  }
  refresh(articleId);
  // Best effort, never blocks the save: forget uploads nobody uses (D-135).
  await removeUnusedMedia(s.supabase, articleId);
  return {
    ok: true,
    lockVersion: row.lock_version,
    revisionId: target.id,
    contentHash: row.content_hash,
    startedNewVersion: target.started,
    notice: target.started
      ? "Saved as a new draft. Readers still see the published version until you publish this one."
      : row.outcome === "unchanged" ? "Nothing had changed." : "Saved.",
  };
}

type Supa = NonNullable<Awaited<ReturnType<typeof staff>>>["supabase"];

async function editableTarget(
  supabase: Supa,
  articleId: string,
  revisionId: string,
  lock: number,
): Promise<{ id: string; lock: number; started: boolean } | { error: JournalState }> {
  const { data: rev } = await supabase.from("journal_revisions").select("id, article_id, state").eq("id", revisionId).maybeSingle();
  if (!rev || rev.article_id !== articleId) return { error: { error: "This version no longer exists. Reload the page." } };
  if (rev.state === "draft" || rev.state === "changes_requested") return { id: rev.id, lock, started: false };
  if (rev.state === "in_review") {
    const { error } = await supabase.rpc("journal_withdraw_submission", { p_revision: rev.id });
    if (error) return { error: refused(error, "withdraw") };
    return { id: rev.id, lock, started: false };
  }
  if (rev.state === "live" || rev.state === "approved") {
    // Someone else already started a newer version: that is an edit conflict,
    // not something to save over silently.
    const { data: art } = await supabase.from("journal_articles").select("working_revision_id").eq("id", articleId).maybeSingle();
    if (!art || art.working_revision_id !== rev.id) {
      return { error: { error: "Someone started a new version of this article while you were editing. Your text is still here — copy anything you need, then reload." } };
    }
    const { data: id, error } = await supabase.rpc("journal_start_revision", { p_article: articleId });
    if (error || !id) return { error: refused(error ?? { message: "" }, "start") };
    const { data: fresh } = await supabase.from("journal_revisions").select("lock_version").eq("id", id).maybeSingle();
    return { id, lock: fresh?.lock_version ?? 1, started: id !== rev.id };
  }
  return { error: { error: "This version can't be edited." } };
}

/** A single workflow step that needs only ids. */
async function step(fd: FormData, op: string, call: (s: NonNullable<Awaited<ReturnType<typeof staff>>>) => PromiseLike<{ error: { message: string } | null }>, notice: string): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  const { error } = await call(s);
  if (error) return refused(error, op);
  refresh(str(fd, "articleId"));
  return { ok: true, notice };
}

export async function setMemberAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const profile = str(fd, "profileId");
  if (!profile) return { fieldErrors: { profileId: "Choose a person." } };
  const role = str(fd, "role");
  return step(fd, "member", (s) => s.supabase.rpc("journal_set_member", {
    p_article: str(fd, "articleId"),
    p_profile: profile,
    p_role: role === "author" || role === "collaborator" ? role : null,
  }), role ? "Access updated." : "Removed from this article.");
}

export async function addCommentAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const body = str(fd, "body").trim();
  if (!body) return { fieldErrors: { body: "Write a comment first." } };
  if (body.length > 5000) return { fieldErrors: { body: "Keep comments under 5,000 characters." } };
  return step(fd, "comment", (s) => s.supabase.rpc("journal_add_comment", {
    p_article: str(fd, "articleId"),
    p_revision: str(fd, "revisionId") || null,
    p_body: body,
    p_parent: str(fd, "parentId") || null,
    p_anchor: str(fd, "anchor").trim().slice(0, 500) || null,
  }), "Comment added. Only Journal staff can see it.");
}

export async function resolveCommentAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const resolved = str(fd, "resolved") !== "0";
  return step(fd, "resolve", (s) => s.supabase.rpc("journal_resolve_comment", { p_comment: str(fd, "commentId"), p_resolved: resolved }), resolved ? "Marked resolved." : "Reopened.");
}

// ---------------------------------------------------------- publishing --
const PUBLISHED_NOTICE = "Published. This version is now live on the public Journal.";

/**
 * A draft may hold a featured image with no description yet; what goes live may
 * not (D-147). Checked here, on what was actually saved, because the database's
 * publish functions don't look at it and the review in the browser is only a
 * courtesy. A scheduled version is locked, so what passes here is what publishes.
 */
async function featuredImageRefusal(supabase: Supa, revisionId: string): Promise<JournalState | null> {
  const { data, error } = await supabase.from("journal_revisions").select("featured_media_id, featured_alt").eq("id", revisionId).maybeSingle();
  if (error) {
    logWarn("journal_action_failed", { op: "publish_check", reason: error.message });
    return { error: "That didn't work. Please try again." };
  }
  if (data?.featured_media_id && !data.featured_alt?.trim()) {
    return { fieldErrors: { featured_alt: FEATURED_ALT_REQUIRED } };
  }
  return null;
}

export async function publishAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  const articleId = str(fd, "articleId");
  const revisionId = str(fd, "revisionId");
  const refusal = await featuredImageRefusal(s.supabase, revisionId);
  if (refusal) return refusal;
  const { error } = await s.supabase.rpc("journal_publish", { p_revision: revisionId, p_expected_hash: str(fd, "contentHash") });
  if (error) {
    const code = journalErrorCode(error);
    // Trying again after the answer to the first try was lost (D-147). The
    // database refuses a second publish, and this version being live is the
    // result that was asked for.
    if (code === "not_publishable") {
      const { data: article } = await s.supabase.from("journal_articles").select("live_revision_id").eq("id", articleId).maybeSingle();
      if (article?.live_revision_id === revisionId) {
        refresh(articleId);
        return { ok: true, notice: PUBLISHED_NOTICE };
      }
    }
    if (code === "slug_taken" || code === "slug_required") return { fieldErrors: { slug: journalErrorMessage(error) } };
    return refused(error, "publish");
  }
  refresh(articleId);
  return { ok: true, notice: PUBLISHED_NOTICE };
}

export async function scheduleAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  // Entered as Europe/London wall time whatever the editor's device zone (D-133).
  const local = str(fd, "atLocal");
  const at = londonWallTimeToUtc(local);
  if (!at.ok) {
    return {
      fieldErrors: {
        atLocal: at.reason === "nonexistent"
          ? "That time doesn't exist in the UK — the clocks go forward then. Choose another time."
          : "Choose a date and time.",
      },
    };
  }
  const s = await staff();
  if (!s) return NOT_STAFF;
  const refusal = await featuredImageRefusal(s.supabase, str(fd, "revisionId"));
  if (refusal) return refusal;
  return step(fd, "schedule", (s) => s.supabase.rpc("journal_schedule", {
    p_revision: str(fd, "revisionId"),
    p_expected_hash: str(fd, "contentHash"),
    p_at: at.utc.toISOString(),
  }), `Scheduled for ${formatLondon(at.utc)}${at.ambiguous ? " — the first of the two 01:00–02:00 hours as the clocks go back" : ""}. It will be published automatically; this version is locked until then.`);
}

export async function cancelScheduleAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  return step(fd, "unschedule", (s) => s.supabase.rpc("journal_cancel_schedule", { p_article: str(fd, "articleId") }), "Schedule cancelled.");
}

export async function unpublishAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  return step(fd, "unpublish", (s) => s.supabase.rpc("journal_unpublish", { p_article: str(fd, "articleId") }), "Unpublished. It is no longer on the public Journal; you can publish it again.");
}

export async function archiveAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const archive = str(fd, "archive") !== "0";
  return step(fd, "archive", (s) => s.supabase.rpc("journal_archive", { p_article: str(fd, "articleId"), p_archive: archive }), archive ? "Archived. It is off the public Journal and locked." : "Restored from the archive. It is not published.");
}

export async function deleteArticleAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  const { error } = await s.supabase.rpc("journal_delete_article", { p_article: str(fd, "articleId") });
  if (error) return refused(error, "delete");
  refresh();
  redirect("/editorial?notice=deleted");
}

// ---------------------------------------------------------------- media --
/**
 * Register an image the browser has just stored in the article's folder
 * (D-135). The bytes are read back here and checked — real type by content,
 * size, and that the name matches the type — before the database accepts it;
 * a file that fails is removed again with the author's own session.
 */
export async function registerUploadAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  const articleId = str(fd, "articleId");
  const path = str(fd, "path");
  const alt = str(fd, "alt").trim().slice(0, 500);
  if (!/^[0-9a-f-]{36}$/.test(articleId) || !isArticleMediaPath(articleId, path)) {
    return { error: "That upload isn't in this article's folder." };
  }
  const bucket = s.supabase.storage.from("journal-media");
  const { data: file, error: readError } = await bucket.download(path);
  if (readError || !file) return { error: "The upload couldn't be found. Try again." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = imageProblem(bytes);
  const type = sniffImage(bytes);
  if (problem || !type || !path.endsWith(`.${type.ext}`)) {
    await bucket.remove([path]);
    return { error: problem ?? "Use a PNG, JPEG, WebP or GIF image." };
  }
  const { data, error } = await s.supabase.rpc("journal_register_media", {
    p_article: articleId, p_path: path, p_mime: type.mime, p_bytes: bytes.byteLength, p_alt: alt || null, p_source_url: null,
  });
  if (error || !data) {
    await bucket.remove([path]);
    return refused(error ?? { message: "" }, "media");
  }
  return { ok: true, mediaId: data, mediaUrl: mediaUrl(data) };
}

// -------------------------------------------------------- preview links --
/** The origin of THIS app, where preview pages live. */
async function appOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

/** A view-only link to the latest saved version (D-134). Shown once. */
export async function createPreviewLinkAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  const articleId = str(fd, "articleId");
  const { data, error } = await s.supabase.rpc("journal_create_preview_link", { p_article: articleId, p_days: 30 });
  const row = data?.[0];
  if (error || !row) return refused(error ?? { message: "" }, "preview_link");
  refresh(articleId);
  return { ok: true, previewUrl: `${await appOrigin()}/journal-preview/${row.token}`, notice: `Preview link created. It works until ${formatLondon(new Date(row.expires_at))} unless you turn it off.` };
}

export async function revokePreviewLinkAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  return step(fd, "preview_revoke", (s) => s.supabase.rpc("journal_revoke_preview_link", { p_link: str(fd, "linkId") }), "Link turned off. Anyone using it now sees “not found”.");
}

// ----------------------------------------------------- people, taxonomy --
export async function setRoleAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  if (!s.caps.isAdmin) return { error: "Only an administrator can change Journal roles." };
  const email = str(fd, "email").trim();
  const role = str(fd, "role");
  if (!email) return { fieldErrors: { email: "Enter the person's account email." } };
  if (role !== "writer" && role !== "reviewer" && role !== "editor") return { fieldErrors: { role: "Choose a role." } };
  const grant = str(fd, "grant") !== "0";
  const { data, error } = await s.supabase.rpc("journal_set_role", { p_email: email, p_role: role, p_grant: grant });
  if (error) return refused(error, "role");
  revalidatePath("/editorial/people");
  const messages: Record<string, string> = {
    granted: `Granted ${role}.`,
    revoked: `Removed ${role}.`,
    unchanged: "Nothing changed.",
    no_such_account: "No WLA account uses that email. They need to sign up first.",
  };
  return data === "no_such_account" ? { fieldErrors: { email: messages[data] } } : { ok: true, notice: messages[data ?? "unchanged"] };
}

const categorySchema = z.object({
  name: z.string().trim().min(1, "Name the category.").max(80),
  slug: z.string().trim(),
  description: z.string().trim().max(300),
  sort_order: z.coerce.number().int().min(0).max(999),
});

export async function saveCategoryAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  if (!s.caps.isEditor) return { error: "Only an editor can change categories." };
  const parsed = categorySchema.safeParse({ name: str(fd, "name"), slug: str(fd, "slug"), description: str(fd, "description"), sort_order: str(fd, "sort_order") || "0" });
  if (!parsed.success) return { fieldErrors: { [String(parsed.error.issues[0].path[0])]: parsed.error.issues[0].message } };
  const slug = parsed.data.slug || slugify(parsed.data.name);
  const problem = slugProblem(slug);
  if (problem) return { fieldErrors: { slug: problem } };
  const id = str(fd, "id");
  const row = { name: parsed.data.name, slug, description: parsed.data.description || null, sort_order: parsed.data.sort_order };
  const { error } = id
    ? await s.supabase.from("journal_categories").update(row).eq("id", id)
    : await s.supabase.from("journal_categories").insert(row);
  if (error) {
    if (/duplicate key/i.test(error.message)) return { fieldErrors: { slug: "Another category already uses that slug." } };
    return refused(error, "category");
  }
  revalidatePath("/editorial/categories");
  revalidatePath("/journal", "layout");
  return { ok: true, notice: id ? "Category saved." : "Category added." };
}

export async function deleteCategoryAction(_prev: JournalState, fd: FormData): Promise<JournalState> {
  const s = await staff();
  if (!s) return NOT_STAFF;
  if (!s.caps.isEditor) return { error: "Only an editor can change categories." };
  const { error } = await s.supabase.from("journal_categories").delete().eq("id", str(fd, "id"));
  if (error) {
    if (/foreign key|violates/i.test(error.message)) return { error: "Articles still use this category. Move them first." };
    return refused(error, "category");
  }
  revalidatePath("/editorial/categories");
  return { ok: true, notice: "Category removed." };
}
