"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Dialog } from "@/components/admin/dialog";
import { useDirtyForm, useUnsavedChanges } from "@/components/admin/unsaved-changes";
import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/field";
import {
  archiveAction,
  cancelScheduleAction,
  createPreviewLinkAction,
  deleteArticleAction,
  registerUploadAction,
  revokePreviewLinkAction,
  saveRevisionAction,
  unpublishAction,
  type JournalState,
} from "@/features/journal/actions";
import { slugify } from "@/features/journal/content";
import { formatLondon } from "@/features/journal/time";
import { checkPickedImage, newUploadPath, prepareImage, uploadToStorage } from "@/features/journal/upload-client";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { ActionButton } from "./action-button";
import {
  CategoryField, ExcerptField, FeaturedImageField, MoreSettingsFields, SlugField, TagsField,
  fieldClass as field, hintClass as hint, labelClass as label, quietClass as quiet,
  type ArticleMeta, type SettingsApi,
} from "./article-settings";
import { PublishReview, type PublishOutcome } from "./publish-review";
import { PeoplePanel } from "./side-panels";
import { RichTextEditor, type UploadImage } from "./rich-text-editor";

/**
 * THE ARTICLE STUDIO (D-137): one calm writing surface.
 *
 *   top bar   — where the article stands, in words, and every publishing
 *               action together: Save draft · Share · Publish
 *   column    — toolbar, title, subtitle, author, then the article itself
 *   sidebar   — Article Settings (D-147), always in view on a wide screen and
 *               one button away on a smaller one
 *   footer    — History · Comments, out of the way until needed
 *
 * Each setting has one value, held here and saved through hidden inputs in the
 * one form, so one Save keeps everything. Publish opens a review that saves
 * first if needed: an author never has to think about "save, then publish".
 * Every rule is still the database's (D-124, D-130).
 */

export type StudioRevision = {
  id: string;
  number: number;
  state: string;
  lock_version: number;
  content_hash: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body_html: string;
  author_name: string | null;
  category_id: string | null;
  tags: string[];
  featured_media_id: string | null;
  featured_alt: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  original_published_at: string | null;
};

export type StudioProps = {
  articleId: string;
  revision: StudioRevision;
  /** Null when this person may edit now; otherwise why not, in words. */
  lockedReason: string | null;
  statusWords: string;
  live: { revisionId: string; number: number; slug: string; publicUrl: string | null; studioViewHref: string } | null;
  scheduled: { at: string; by: string } | null;
  scheduler: { configured: boolean; active: boolean; overdue: number } | null;
  canPublish: boolean;
  isEditor: boolean;
  archived: boolean;
  everPublished: boolean;
  publicSiteOrigin: string | null;
  categories: { id: string; name: string }[];
  knownTags: string[];
  media: { id: string; alt: string | null }[];
  previewLinks: { id: string; createdAt: string; expiresAt: string; by: string }[];
  people: { members: { id: string; name: string; role: "author" | "collaborator" }[]; writers: { id: string; name: string }[]; canManage: boolean };
  comments: ReactNode;
  commentCount: number;
  history: ReactNode;
};

export function ArticleStudio(p: StudioProps) {
  const uid = useId();
  const formId = `${uid}-form`;
  const router = useRouter();
  const { setDirty } = useUnsavedChanges();
  const { ref: formRef, dirty, saved } = useDirtyForm("article", p.revision.title ? `“${p.revision.title}”` : "this article");

  const editable = p.lockedReason === null;
  const [revisionId, setRevisionId] = useState(p.revision.id);
  const [lock, setLock] = useState(p.revision.lock_version);
  const [contentHash, setContentHash] = useState(p.revision.content_hash);
  const [title, setTitle] = useState(p.revision.title);
  const [body, setBody] = useState(p.revision.body_html);
  const [meta, setMeta] = useState<ArticleMeta>(() => ({
    slug: p.revision.slug,
    excerpt: p.revision.excerpt ?? "",
    authorName: p.revision.author_name ?? "",
    categoryId: p.revision.category_id ?? "",
    tags: p.revision.tags,
    featured: p.revision.featured_media_id ?? "",
    featuredAlt: p.revision.featured_alt ?? "",
    seoTitle: p.revision.seo_title ?? "",
    seoDescription: p.revision.seo_description ?? "",
    canonicalUrl: p.revision.canonical_url ?? "",
    originalDate: p.revision.original_published_at?.slice(0, 10) ?? "",
  }));
  // A new article's URL follows its title until someone sets it by hand.
  const [slugFollows, setSlugFollows] = useState(!p.everPublished && (p.revision.slug === "" || p.revision.slug === slugify(p.revision.title)));
  const [media, setMedia] = useState(p.media);
  const [pending, setPending] = useState(0);
  const [featuredBusy, setFeaturedBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<JournalState>({});
  const [panel, setPanel] = useState<null | "history" | "comments">(null);
  // Only matters below the wide layout, where the settings open over the page.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "publish" | "share">(null);
  const resolver = useRef<((r: JournalState) => void) | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const settingsOpener = useRef<Element | null>(null);

  // The toolbar sticks below the app header and this bar, whatever their height.
  useEffect(() => {
    const el = barRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const set = () => root.style.setProperty("--studio-bar-height", `${64 + el.offsetHeight}px`);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const key = (e: KeyboardEvent) => { if (e.key === "Tab") root.dataset.focusSource = "keyboard"; };
    const pointer = () => { root.dataset.focusSource = "pointer"; };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", pointer, true);
      delete root.dataset.focusSource;
    };
  }, []);

  useEffect(() => {
    if (slugFollows) setMeta((m) => ({ ...m, slug: slugify(title) })); // eslint-disable-line react-hooks/set-state-in-effect -- derived default, overridable
  }, [title, slugFollows]);

  // What was refused no longer applies once it has been changed.
  const clearFieldErrors = useCallback(() => setResult((r) => (r.fieldErrors ? { ...r, fieldErrors: undefined } : r)), []);
  const patch = useCallback((change: Partial<ArticleMeta>) => {
    setMeta((m) => ({ ...m, ...change }));
    clearFieldErrors();
  }, [clearFieldErrors]);
  const changeTitle = useCallback((v: string) => {
    setTitle(v);
    clearFieldErrors();
  }, [clearFieldErrors]);

  // Below the wide layout: focus moves into the settings and back out again.
  useEffect(() => {
    // On a wide screen they are already in view, and there's nothing to move to.
    const overlay = settingsClose.current && getComputedStyle(settingsClose.current).display !== "none";
    if (settingsOpen && overlay) {
      settingsOpener.current = document.activeElement;
      settingsHeading.current?.focus();
    } else if (!settingsOpen && settingsOpener.current instanceof HTMLElement) {
      settingsOpener.current.focus();
      settingsOpener.current = null;
    }
  }, [settingsOpen]);

  // ------------------------------------------------------------ saving --
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const done = resolver.current;
    resolver.current = null;
    if (pending > 0) {
      const r = { error: pending === 1 ? "An image is still uploading (or failed). Wait for it, or remove it, then save." : `${pending} images are still uploading (or failed). Wait for them, or remove them, then save.` };
      setResult(r);
      done?.(r);
      return;
    }
    const fd = new FormData(e.currentTarget);
    setSaving(true);
    let r: JournalState;
    try {
      r = await saveRevisionAction({}, fd);
    } catch {
      r = { error: "That didn't save — the connection dropped. Your text is still here; try again." };
    }
    setSaving(false);
    setResult(r);
    // A refused setting mustn't be hidden behind a closed panel.
    if (r.fieldErrors && dialog === null && Object.keys(r.fieldErrors).some((k) => k !== "title" && k !== "body_html")) setSettingsOpen(true);
    if (r.ok) {
      if (r.lockVersion) setLock(r.lockVersion);
      if (r.revisionId) setRevisionId(r.revisionId);
      if (r.contentHash) setContentHash(r.contentHash);
      setLastSaved(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
      saved();
      router.refresh();
    }
    done?.(r);
  };

  /** Save through the form (so unsaved-change tracking sees it) and wait. */
  const saveNow = useCallback(
    () =>
      new Promise<JournalState>((resolve) => {
        if (!formRef.current) return resolve({ error: "The editor isn't ready." });
        resolver.current = resolve;
        formRef.current.requestSubmit();
      }),
    [formRef],
  );

  // ----------------------------------------------------------- uploads --
  const uploadImage: UploadImage = useCallback(
    async (file, onProgress) => {
      const checked = await checkPickedImage(file);
      if ("error" in checked) return checked;
      const prepared = await prepareImage(file, checked.type);
      if ("error" in prepared) return prepared;
      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) return { error: "Your session has expired. Reload the page, sign in, and try again." };
      const path = newUploadPath(p.articleId, file.name, prepared.type.ext);
      try {
        await uploadToStorage({
          supabaseUrl: publicEnv.supabaseUrl,
          anonKey: publicEnv.supabaseAnonKey,
          accessToken: token,
          path,
          blob: prepared.blob,
          contentType: prepared.type.mime,
          onProgress: (f) => onProgress(f * 0.9),
        });
      } catch (e) {
        return { error: e instanceof Error ? e.message : "The image couldn't be uploaded. Try again." };
      }
      const fd = new FormData();
      fd.set("articleId", p.articleId);
      fd.set("path", path);
      const r = await registerUploadAction({}, fd).catch(() => ({ error: "The image couldn't be saved. Try again." }) as JournalState);
      if (!r.ok || !r.mediaId || !r.mediaUrl) return { error: r.error ?? "The image couldn't be saved. Try again." };
      onProgress(1);
      setMedia((m) => [{ id: r.mediaId!, alt: null }, ...m]);
      return { mediaId: r.mediaId, src: r.mediaUrl };
    },
    [p.articleId],
  );

  const onPendingUploads = useCallback((n: number) => setPending(n), []);
  const uploading = pending + (featuredBusy ? 1 : 0);

  // While uploading, leaving the page would lose the image.
  useEffect(() => {
    setDirty("uploads", uploading > 0 ? "images that are still uploading" : null);
  }, [uploading, setDirty]);

  // A save can remove unused images on the server, so follow what it now says.
  const serverMedia = p.media;
  useEffect(() => { setMedia(serverMedia); }, [serverMedia]); // eslint-disable-line react-hooks/set-state-in-effect -- the server's list is the truth after a refresh

  const focusEditor = useCallback(() => {
    setDialog(null);
    window.setTimeout(() => document.querySelector<HTMLElement>(`[aria-labelledby="${uid}-body"]`)?.focus(), 50);
  }, [uid]);

  const onPublished = useCallback((outcome: PublishOutcome) => {
    router.push(`/editorial?notice=${outcome}&article=${p.articleId}`);
  }, [router, p.articleId]);

  const api: SettingsApi = {
    meta,
    patch,
    errors: result.fieldErrors ?? {},
    slugFollows,
    setSlug: (v) => { patch({ slug: v }); setSlugFollows(false); },
    followTitle: () => setSlugFollows(true),
    media,
    uploadImage,
    onFeaturedBusy: setFeaturedBusy,
    categories: p.categories,
    knownTags: p.knownTags,
    publicSiteOrigin: p.publicSiteOrigin,
    everPublished: p.everPublished,
  };

  const saveWords = saving ? "Saving…" : dirty ? "Unsaved changes" : lastSaved ? `Draft saved at ${lastSaved}` : "Saved";
  const hasNewVersion = Boolean(p.live && (revisionId !== p.live.revisionId || dirty));

  return (
    <div ref={rootRef} className="pb-[var(--space-3xl)]">
      {/* The page's heading: the title field below is an input, not a heading. */}
      <h1 className="sr-only">{title.trim() || "Untitled draft"} — Journal studio</h1>
      {/* ------------------------------------------------------------ top bar */}
      <div ref={barRef} className="sticky top-[64px] z-30 border-b border-[var(--color-border)] bg-[var(--color-background)]">
        <div className="flex flex-wrap items-center gap-x-[var(--space-m)] gap-y-[var(--space-xs)] px-[var(--space-m)] py-[var(--space-xs)] lg:px-[var(--space-l)]">
          <Link href="/editorial" className={quiet}>
            <span aria-hidden="true">←</span> Articles
          </Link>
          <p className="flex flex-wrap items-center gap-[var(--space-s)] text-[length:var(--text-small)]" role="status" aria-live="polite">
            <span className="rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-[var(--space-xs)] py-[2px] font-medium">
              {p.statusWords}
              {p.live && dirty && !p.statusWords.includes("unpublished") ? " · unpublished changes" : ""}
            </span>
            {editable && <span className="text-[var(--color-text-muted)]">{saveWords}</span>}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-[var(--space-s)]">
            {editable && (
              <Button type="submit" form={formId} variant="secondary" isLoading={saving} loadingLabel="Saving…">
                Save draft
              </Button>
            )}
            {editable && (
              <Button type="button" variant="secondary" onClick={() => setDialog("share")}>
                Share
              </Button>
            )}
            <button
              type="button"
              className={`${quiet} border border-[var(--color-border-strong)] xl:hidden`}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((o) => !o)}
            >
              Article Settings
            </button>
            {p.canPublish && editable && (
              <Button type="button" onClick={() => setDialog("publish")}>
                {p.live ? "Update Article" : "Publish"}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <div className="mx-auto w-full min-w-0 max-w-[46rem] px-[var(--space-m)] pt-[var(--space-m)] md:px-[var(--space-xl)]">
        {p.scheduled && (
          <div role="note" className="mb-[var(--space-m)] rounded-[var(--radius-input)] border border-[var(--color-border-strong)] bg-[var(--color-surface-sage)] p-[var(--space-m)]">
            <p>
              <strong>Scheduled</strong> to publish automatically on {formatLondon(p.scheduled.at)} (set by {p.scheduled.by}). It&rsquo;s locked until then.
            </p>
            {p.canPublish && (
              <div className="mt-[var(--space-s)]">
                <ActionButton action={cancelScheduleAction} fields={{ articleId: p.articleId }} label="Cancel the schedule to make changes" />
              </div>
            )}
          </div>
        )}
        {p.lockedReason && !p.scheduled && (
          <p role="note" className="mb-[var(--space-m)] rounded-[var(--radius-input)] border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] p-[var(--space-m)]">
            {p.lockedReason}
          </p>
        )}
        {p.live && (
          <p className={`mb-[var(--space-m)] ${hint}`}>
            {hasNewVersion ? "Readers still see the published version until you publish your changes. " : "This is the published version. "}
            {p.live.publicUrl ? (
              <a href={p.live.publicUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">View it on the public Journal (new tab)</a>
            ) : (
              <Link href={p.live.studioViewHref} className="underline underline-offset-4">Read the published version</Link>
            )}
          </p>
        )}
        {result.conflict && (
          <div role="alert" className="mb-[var(--space-m)] rounded-[var(--radius-input)] border border-[var(--color-error)] bg-[var(--color-surface)] p-[var(--space-m)]">
            <p className="font-medium">Someone else saved this article while you were editing.</p>
            <p className="mt-[var(--space-xs)] text-[length:var(--text-small)]">
              {result.conflict.by ?? "Another editor"} saved it at {new Date(result.conflict.at).toLocaleString("en-GB")}. Your text is still here, unsaved.
            </p>
            <div className="mt-[var(--space-s)] flex flex-wrap gap-[var(--space-m)]">
              <Button type="button" variant="secondary" onClick={() => { setDirty("article", null); window.setTimeout(() => window.location.reload(), 50); }}>
                Discard mine and load theirs
              </Button>
              <Button type="button" variant="secondary" onClick={() => { setLock(result.conflict!.lockVersion); setResult({ notice: "Now press “Save draft” to replace their changes with yours." }); }}>
                Keep mine — I&rsquo;ll save over theirs
              </Button>
            </div>
          </div>
        )}
        {!result.conflict && <div className="mb-[var(--space-s)]"><FormError message={result.error ?? Object.values(result.fieldErrors ?? {})[0]} /></div>}
        {!result.conflict && result.ok && result.startedNewVersion && <div className="mb-[var(--space-s)]"><FormNotice message={result.notice} /></div>}

        {/* ------------------------------------------------------- the article */}
        <form id={formId} ref={formRef} onSubmit={onSubmit}>
          <input type="hidden" name="articleId" value={p.articleId} />
          <input type="hidden" name="revisionId" value={revisionId} data-dirty-ignore="" />
          <input type="hidden" name="lockVersion" value={lock} data-dirty-ignore="" />
          <input type="hidden" name="body_html" value={body} />
          {/* Each setting's one saved value, whichever field last changed it. */}
          <input type="hidden" name="slug" value={meta.slug} />
          <input type="hidden" name="excerpt" value={meta.excerpt} />
          <input type="hidden" name="author_name" value={meta.authorName} />
          <input type="hidden" name="category_id" value={meta.categoryId} />
          <input type="hidden" name="tags" value={meta.tags.join(", ")} />
          <input type="hidden" name="featured_media_id" value={meta.featured} />
          <input type="hidden" name="featured_alt" value={meta.featured ? meta.featuredAlt : ""} />
          <input type="hidden" name="seo_title" value={meta.seoTitle} />
          <input type="hidden" name="seo_description" value={meta.seoDescription} />
          <input type="hidden" name="canonical_url" value={meta.canonicalUrl} />
          <input type="hidden" name="original_published_at" value={meta.originalDate} />
          <span id={`${uid}-body`} className="sr-only">Article text</span>
          <RichTextEditor
            value={p.revision.body_html}
            onChange={setBody}
            labelId={`${uid}-body`}
            uploadImage={uploadImage}
            onPendingUploads={onPendingUploads}
            readOnly={!editable}
            header={
              <div className="mb-[var(--space-l)] flex flex-col gap-[var(--space-s)]">
                <label htmlFor={`${uid}-title`} className="sr-only">Title</label>
                <AutoTextarea
                  id={`${uid}-title`}
                  name="title"
                  value={title}
                  onChange={changeTitle}
                  placeholder="Title"
                  maxLength={200}
                  readOnly={!editable}
                  className="wla-display font-[family-name:var(--font-serif)]"
                />
                {result.fieldErrors?.title && <p role="alert" className="text-[length:var(--text-small)] text-[var(--color-error)]">{result.fieldErrors.title}</p>}
                <label htmlFor={`${uid}-sub`} className="sr-only">Subtitle — also shown on the Journal listing</label>
                <AutoTextarea
                  id={`${uid}-sub`}
                  value={meta.excerpt}
                  onChange={(v) => patch({ excerpt: v })}
                  placeholder="Add a subtitle…"
                  maxLength={600}
                  readOnly={!editable}
                  className="font-[family-name:var(--font-serif)] text-[length:var(--text-body-lg)] italic text-[var(--color-text-muted)]"
                />
                <div className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-small)]">
                  <label htmlFor={`${uid}-author`} className="text-[var(--color-text-muted)]">By</label>
                  <input
                    id={`${uid}-author`}
                    value={meta.authorName}
                    onChange={(e) => patch({ authorName: e.target.value })}
                    placeholder="Author name"
                    maxLength={120}
                    readOnly={!editable}
                    className="journal-writing min-h-[var(--target-min)] w-[16rem] max-w-full rounded-[var(--radius-control)] border border-transparent bg-transparent px-[var(--space-xs)] hover:border-[var(--color-border)]"
                  />
                </div>
              </div>
            }
          />
        </form>
      </div>

      {/* ---------------------------------------------------- article settings */}
      <aside
        aria-labelledby={`${uid}-settings`}
        onKeyDown={(e) => { if (e.key === "Escape" && settingsOpen) setSettingsOpen(false); }}
        className={`${settingsOpen ? "" : "hidden"} fixed inset-y-0 right-0 z-40 w-[min(28rem,100vw)] overflow-y-auto border-l border-[var(--color-border-strong)] bg-[var(--color-background)] p-[var(--space-l)] shadow-[var(--shadow-overlay)] xl:sticky xl:inset-auto xl:top-[var(--studio-bar-height)] xl:z-10 xl:block xl:h-[calc(100dvh-var(--studio-bar-height))] xl:w-auto xl:border-[var(--color-border)] xl:pb-[var(--space-3xl)] xl:shadow-none`}
      >
        <div className="mb-[var(--space-l)] flex items-center justify-between gap-[var(--space-m)]">
          <h2 id={`${uid}-settings`} ref={settingsHeading} tabIndex={-1} className="text-[length:var(--text-h3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]">Article Settings</h2>
          <button ref={settingsClose} type="button" onClick={() => setSettingsOpen(false)} className={`${quiet} xl:hidden`} aria-label="Close article settings">
            <span aria-hidden="true">✕</span> Close
          </button>
        </div>
        <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-[var(--space-l)]">
          <FeaturedImageField api={api} idPrefix={`${uid}-side`} />
          <SlugField api={api} idPrefix={`${uid}-side`} />
          <CategoryField api={api} idPrefix={`${uid}-side`} />
          <TagsField api={api} idPrefix={`${uid}-side`} />
          <ExcerptField api={api} idPrefix={`${uid}-side`} />
          <MoreSettingsFields api={api} idPrefix={`${uid}-side`} />
        </fieldset>
        <ArticleActions {...p} />
      </aside>
      </div>

      {/* ------------------------------------------------------------ footer */}
      <div className="sticky bottom-0 z-20 mt-[var(--space-l)] border-t border-[var(--color-border)] bg-[var(--color-background)]">
        <div className="flex flex-wrap items-center gap-[var(--space-s)] px-[var(--space-m)] py-[var(--space-xs)] lg:px-[var(--space-l)]">
          <button type="button" className={quiet} aria-expanded={panel === "history"} onClick={() => setPanel(panel === "history" ? null : "history")}>History</button>
          <button type="button" className={quiet} aria-expanded={panel === "comments"} onClick={() => setPanel(panel === "comments" ? null : "comments")}>
            Comments{p.commentCount ? ` (${p.commentCount})` : ""}
          </button>
        </div>
      </div>

      <Panel open={panel === "history"} onClose={() => setPanel(null)} title="History">{p.history}</Panel>
      <Panel open={panel === "comments"} onClose={() => setPanel(null)} title="Comments">{p.comments}</Panel>

      {/* ------------------------------------------------------------ dialogs */}
      <PublishReview
        open={dialog === "publish"}
        onBack={() => setDialog(null)}
        onFocusEditor={focusEditor}
        onDone={onPublished}
        api={api}
        articleId={p.articleId}
        isUpdate={Boolean(p.live)}
        title={title}
        setTitle={changeTitle}
        body={body}
        dirty={dirty}
        pendingUploads={uploading}
        revisionId={revisionId}
        liveRevisionId={p.live?.revisionId ?? null}
        contentHash={contentHash}
        saveNow={saveNow}
        scheduler={p.scheduler}
      />
      <ShareDialog open={dialog === "share"} onClose={() => setDialog(null)} p={p} dirty={dirty} saveNow={saveNow} saving={saving} />
    </div>
  );
}

// ---------------------------------------------------------------- pieces --

function AutoTextarea({
  id, name, value, defaultValue, onChange, placeholder, maxLength, readOnly, className,
}: {
  id: string; name?: string; value?: string; defaultValue?: string; onChange?: (v: string) => void;
  placeholder: string; maxLength: number; readOnly?: boolean; className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fit);
  return (
    <textarea
      ref={ref}
      id={id}
      name={name}
      rows={1}
      value={value}
      defaultValue={defaultValue}
      onChange={(e) => { onChange?.(e.target.value); fit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
      placeholder={placeholder}
      maxLength={maxLength}
      readOnly={readOnly}
      className={`journal-writing w-full resize-none overflow-hidden border-0 bg-transparent p-0 placeholder:text-[var(--color-text-muted)] rounded-[var(--radius-control)] ${className ?? ""}`}
    />
  );
}

/**
 * A side panel that stays MOUNTED when closed (`hidden`), so the settings
 * fields inside it keep their values and are submitted with the article.
 */
function Panel({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const h = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      headingRef.current?.focus();
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
      opener.current = null;
    }
  }, [open]);
  return (
    <aside
      hidden={!open}
      aria-labelledby={h}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      className="fixed inset-y-0 right-0 z-40 w-[min(28rem,100vw)] overflow-y-auto border-l border-[var(--color-border-strong)] bg-[var(--color-background)] p-[var(--space-l)] shadow-[var(--shadow-overlay)]"
    >
      <div className="mb-[var(--space-l)] flex items-center justify-between gap-[var(--space-m)]">
        <h2 id={h} ref={headingRef} tabIndex={-1} className="text-[length:var(--text-h3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]">{title}</h2>
        <button type="button" onClick={onClose} className={quiet} aria-label={`Close ${title.toLowerCase()}`}>
          <span aria-hidden="true">✕</span> Close
        </button>
      </div>
      {children}
    </aside>
  );
}


/** Unpublish, archive, delete — consequential, so out of the writing flow. */
function ArticleActions(p: StudioProps) {
  const anything = (p.live && p.canPublish) || p.isEditor;
  if (!anything) return null;
  return (
    <section className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]">
      <h3 className="text-[length:var(--text-h3)]">This article</h3>
      <div className="mt-[var(--space-m)] flex flex-col gap-[var(--space-m)]">
        {p.live && p.canPublish && !p.archived && (
          <ActionButton
            action={unpublishAction}
            fields={{ articleId: p.articleId }}
            label="Unpublish"
            confirm={{ title: "Unpublish this article?", body: <p>It disappears from the public Journal straight away. Nothing is deleted, and you can publish it again.</p>, confirmLabel: "Unpublish", destructive: true }}
          />
        )}
        {p.isEditor && (
          <ActionButton
            action={archiveAction}
            fields={{ articleId: p.articleId, archive: p.archived ? 0 : 1 }}
            label={p.archived ? "Restore from the archive" : "Archive"}
            confirm={p.archived ? undefined : { title: "Archive this article?", body: <p>It disappears from the public Journal straight away, any schedule is cancelled, and it can&rsquo;t be edited until it is restored. Nothing is deleted.</p>, confirmLabel: "Archive", destructive: true }}
          />
        )}
        {p.isEditor && !p.everPublished && !p.archived && (
          <ActionButton
            action={deleteArticleAction}
            fields={{ articleId: p.articleId }}
            label="Delete this draft"
            variant="text"
            confirm={{ title: "Delete this draft for good?", body: <p>Every version and comment is removed. The record that it was deleted is kept. This can&rsquo;t be undone.</p>, confirmLabel: "Delete", destructive: true }}
          />
        )}
      </div>
    </section>
  );
}


// --------------------------------------------------------------- sharing --
function ShareDialog({ open, onClose, p, dirty, saveNow, saving }: { open: boolean; onClose: () => void; p: StudioProps; dirty: boolean; saveNow: () => Promise<JournalState>; saving: boolean }) {
  const uid = useId();
  const [made, setMade] = useState<JournalState>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const create = async () => {
    setBusy(true);
    setCopied(false);
    const fd = new FormData();
    fd.set("articleId", p.articleId);
    const r = await createPreviewLinkAction({}, fd).catch(() => ({ error: "The connection dropped. Try again." }) as JournalState);
    setBusy(false);
    setMade(r);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Share a preview">
      <div className="flex flex-col gap-[var(--space-l)]">
        <section aria-labelledby={`${uid}-v`}>
          <h3 id={`${uid}-v`} className="text-[length:var(--text-label)] font-semibold">Anyone with the link can read it</h3>
          <p className={`mt-[var(--space-xs)] ${hint}`}>
            View only. The link shows the latest <strong>saved</strong> version; they can&rsquo;t edit it, and it doesn&rsquo;t appear on the public Journal. Links work for 30 days unless you turn them off.
          </p>
          {dirty && (
            <p className="mt-[var(--space-s)] text-[length:var(--text-small)]">
              You have unsaved changes, which the link won&rsquo;t show yet.{" "}
              <Button type="button" variant="text" onClick={() => void saveNow()} isLoading={saving} loadingLabel="Saving…">Save draft now</Button>
            </p>
          )}
          {made.previewUrl ? (
            <div className="mt-[var(--space-s)] flex flex-col gap-[var(--space-xs)]">
              <label htmlFor={`${uid}-url`} className={label}>Your preview link</label>
              <div className="flex flex-wrap gap-[var(--space-s)]">
                <input id={`${uid}-url`} readOnly value={made.previewUrl} onFocus={(e) => e.currentTarget.select()} className={`${field} min-h-[var(--target-min)] flex-1 min-w-[12rem] font-mono text-[length:var(--text-small)]`} />
                <Button type="button" variant="secondary" onClick={async () => { await navigator.clipboard?.writeText(made.previewUrl!); setCopied(true); }}>
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <p className={hint} role="status">{copied ? "Copied. " : ""}Copy it now — for safety the full link is shown only once. If you lose it, make a new one.</p>
            </div>
          ) : (
            <div className="mt-[var(--space-s)]">
              <Button type="button" variant="secondary" onClick={create} isLoading={busy} loadingLabel="Creating…">Create a preview link</Button>
            </div>
          )}
          <FormError message={made.error} />
          {p.previewLinks.length > 0 && (
            <div className="mt-[var(--space-m)]">
              <h4 className="text-[length:var(--text-small)] font-semibold">Links that work now</h4>
              <ul className="mt-[var(--space-xs)] flex flex-col gap-[var(--space-s)]">
                {p.previewLinks.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-[var(--space-s)] text-[length:var(--text-small)]">
                    <span>Made by {l.by}, {formatLondon(l.createdAt)} · until {formatLondon(l.expiresAt)}</span>
                    <ActionButton action={revokePreviewLinkAction} fields={{ articleId: p.articleId, linkId: l.id }} label="Turn off" variant="text" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section aria-labelledby={`${uid}-e`} className="border-t border-[var(--color-border)] pt-[var(--space-m)]">
          <h3 id={`${uid}-e`} className="sr-only">People who can edit</h3>
          <PeoplePanel articleId={p.articleId} members={p.people.members} writers={p.people.writers} canManage={p.people.canManage} />
          <p className={`mt-[var(--space-xs)] ${hint}`}>Editing needs a Journal account. A preview link never lets anyone edit.</p>
        </section>

        <div>
          <Button type="button" variant="secondary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
