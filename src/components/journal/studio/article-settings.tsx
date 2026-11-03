"use client";

import { useId, useRef, useState, type ReactNode } from "react";

import { mediaUrl, normaliseTags, tagLabel } from "@/features/journal/content";
import type { UploadImage } from "./rich-text-editor";

/**
 * THE ARTICLE'S SETTINGS (D-147).
 *
 * There is one copy of each value: `ArticleMeta`, held by the studio. These fields
 * only show and change it, whether they sit in the Article Settings sidebar or in
 * the review before publishing, and they carry no `name`. What gets saved is the
 * hidden inputs in the studio's one form, so two places can't send two answers.
 */
export type ArticleMeta = {
  slug: string;
  excerpt: string;
  authorName: string;
  categoryId: string;
  tags: string[];
  featured: string;
  featuredAlt: string;
  seoTitle: string;
  seoDescription: string;
  canonicalUrl: string;
  originalDate: string;
};

export type SettingsApi = {
  meta: ArticleMeta;
  patch: (change: Partial<ArticleMeta>) => void;
  /** By saved field name, from the server or the check before publishing. */
  errors: Record<string, string | undefined>;
  slugFollows: boolean;
  setSlug: (value: string) => void;
  followTitle: () => void;
  media: { id: string; alt: string | null }[];
  uploadImage: UploadImage;
  onFeaturedBusy: (busy: boolean) => void;
  categories: { id: string; name: string }[];
  knownTags: string[];
  publicSiteOrigin: string | null;
  everPublished: boolean;
};

export const fieldClass =
  "w-full rounded-[var(--radius-input)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-[var(--space-s)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] aria-[invalid=true]:border-2 aria-[invalid=true]:border-[var(--color-error)]";
export const labelClass = "text-[length:var(--text-label)] font-medium";
export const hintClass = "text-[length:var(--text-small)] text-[var(--color-text-muted)]";
export const quietClass =
  "inline-flex min-h-[var(--target-min)] items-center gap-[var(--space-xs)] rounded-[var(--radius-control)] px-[var(--space-s)] text-[length:var(--text-small)] hover:bg-[var(--color-surface-raised)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]";

/** Where readers will find it, in words. */
export function webAddress(origin: string | null, slug: string): string {
  const path = `/journal/${slug || "…"}`;
  return origin ? `${origin}${path}` : `${path} on the public website`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={id} className="text-[length:var(--text-small)] text-[var(--color-error)]">{message}</p>;
}

function Group({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[var(--space-xs)]">{children}</div>;
}

export function SlugField({ api, idPrefix }: { api: SettingsApi; idPrefix: string }) {
  const id = `${idPrefix}-slug`;
  const error = api.errors.slug;
  return (
    <Group>
      <label htmlFor={id} className={labelClass}>Web address</label>
      <input
        id={id}
        value={api.meta.slug}
        onChange={(e) => api.setSlug(e.target.value)}
        maxLength={120}
        className={`${fieldClass} min-h-[var(--target-min)]`}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-h${error ? ` ${id}-e` : ""}`}
      />
      <p id={`${id}-h`} className={`${hintClass} [overflow-wrap:anywhere]`}>
        {webAddress(api.publicSiteOrigin, api.meta.slug)}
        {api.slugFollows ? " — follows the title until you change it." : ""}
      </p>
      {api.everPublished && <p className={hintClass}>Changing this moves the published article to a new address.</p>}
      <FieldError id={`${id}-e`} message={error} />
      {!api.slugFollows && !api.everPublished && (
        <button type="button" className={`${quietClass} self-start underline`} onClick={api.followTitle}>Make it from the title</button>
      )}
    </Group>
  );
}

export function CategoryField({ api, idPrefix }: { api: SettingsApi; idPrefix: string }) {
  const id = `${idPrefix}-cat`;
  return (
    <Group>
      <label htmlFor={id} className={labelClass}>Category</label>
      <select id={id} value={api.meta.categoryId} onChange={(e) => api.patch({ categoryId: e.target.value })} className={`${fieldClass} min-h-[var(--target-min)]`}>
        <option value="">No category</option>
        {api.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {api.categories.length === 0 && <p className={hintClass}>There are no categories yet. Editors add them under Categories.</p>}
    </Group>
  );
}

export function TagsField({ api, idPrefix }: { api: SettingsApi; idPrefix: string }) {
  const id = `${idPrefix}-tags`;
  const [draft, setDraft] = useState("");
  const tags = api.meta.tags;
  const add = (text: string) => {
    const added = normaliseTags(text).filter((t) => !tags.includes(t));
    if (added.length) api.patch({ tags: [...tags, ...added] });
    setDraft("");
  };
  const typed = draft.trim().toLowerCase();
  const suggestions = api.knownTags
    .filter((t) => !tags.includes(t) && (!typed || tagLabel(t).includes(typed)))
    .slice(0, 8);
  return (
    <Group>
      <label htmlFor={id} className={labelClass}>Tags</label>
      {tags.length > 0 && (
        <ul aria-label="Tags on this article" className="flex flex-wrap gap-[var(--space-xs)]">
          {tags.map((t) => (
            <li key={t} className="inline-flex items-center rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] pl-[var(--space-xs)] text-[length:var(--text-small)]">
              {tagLabel(t)}
              <button
                type="button"
                aria-label={`Remove tag ${tagLabel(t)}`}
                onClick={() => api.patch({ tags: tags.filter((x) => x !== t) })}
                className="ml-[2px] inline-flex size-[var(--target-min)] items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        value={draft}
        onChange={(e) => {
          if (e.target.value.includes(",")) add(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); add(draft); }
        }}
        // A tag typed but not yet added isn't lost by moving on, or by pressing Publish.
        onBlur={() => { if (draft.trim()) add(draft); }}
        className={`${fieldClass} min-h-[var(--target-min)]`}
        aria-describedby={`${id}-h`}
      />
      <p id={`${id}-h`} className={hintClass}>Type a tag and press Enter, or separate several with commas.</p>
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-[var(--space-xs)]">
          <p className={hintClass}>Tags already in use:</p>
          <ul className="flex flex-wrap gap-[var(--space-xs)]">
            {suggestions.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  aria-label={`Add tag ${tagLabel(t)}`}
                  // Before the field's blur, so the half-typed text isn't added as well.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { api.patch({ tags: [...tags, t] }); setDraft(""); }}
                  className="min-h-[var(--target-min)] rounded-[var(--radius-control)] border border-[var(--color-border)] px-[var(--space-xs)] text-[length:var(--text-small)] hover:bg-[var(--color-surface-raised)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
                >
                  {tagLabel(t)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Group>
  );
}

export function ExcerptField({ api, idPrefix }: { api: SettingsApi; idPrefix: string }) {
  const id = `${idPrefix}-excerpt`;
  const error = api.errors.excerpt;
  return (
    <Group>
      <label htmlFor={id} className={labelClass}>Excerpt</label>
      <textarea
        id={id}
        value={api.meta.excerpt}
        onChange={(e) => api.patch({ excerpt: e.target.value })}
        maxLength={600}
        rows={3}
        className={`${fieldClass} py-[var(--space-xs)]`}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-h${error ? ` ${id}-e` : ""}`}
      />
      <p id={`${id}-h`} className={hintClass}>The subtitle under the title, also shown on the Journal listing.</p>
      <FieldError id={`${id}-e`} message={error} />
    </Group>
  );
}

export function FeaturedImageField({ api, idPrefix }: { api: SettingsApi; idPrefix: string }) {
  const altId = `${idPrefix}-falt`;
  const groupId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ progress: number; error?: string } | null>(null);
  const { featured, featuredAlt } = api.meta;
  const others = api.media.filter((m) => m.id !== featured);
  const error = api.errors.featured_alt;

  const onFile = async (file: File) => {
    setUpload({ progress: 0 });
    api.onFeaturedBusy(true);
    try {
      const r = await api.uploadImage(file, (x) => setUpload({ progress: x }));
      if ("error" in r) setUpload({ progress: 0, error: r.error });
      else {
        setUpload(null);
        // A new picture needs its own description, not the last one's.
        api.patch({ featured: r.mediaId, featuredAlt: "" });
      }
    } finally {
      api.onFeaturedBusy(false);
    }
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-[var(--space-s)]">
      <legend className={`${labelClass} mb-[var(--space-xs)]`}>Featured image</legend>
      {featured ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mediaUrl(featured)}
          alt="The chosen featured image"
          className="aspect-[16/9] max-h-[12rem] w-full rounded-[var(--radius-control)] border border-[var(--color-border)] object-cover"
        />
      ) : (
        <p className={`flex min-h-[7rem] w-full items-center justify-center rounded-[var(--radius-control)] border border-dashed border-[var(--color-border-strong)] p-[var(--space-m)] text-center ${hintClass}`}>
          No featured image. It&rsquo;s optional, and shows at the top of the article and when it&rsquo;s shared.
        </p>
      )}
      <div className="flex flex-wrap gap-[var(--space-xs)]">
        <button type="button" className={`${quietClass} border border-[var(--color-border-strong)]`} onClick={() => fileRef.current?.click()}>
          {featured ? "Replace image" : "Upload image"}
        </button>
        {featured && (
          <button type="button" className={quietClass} onClick={() => api.patch({ featured: "", featuredAlt: "" })}>
            Remove image
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          hidden
          aria-label="Choose a featured image file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onFile(f);
          }}
        />
      </div>
      {upload && !upload.error && <p role="status" className={hintClass}>Uploading — {Math.round(upload.progress * 100)}%</p>}
      {upload?.error && <p role="alert" className="text-[length:var(--text-small)] text-[var(--color-error)]">{upload.error}</p>}
      {featured && (
        <Group>
          <label htmlFor={altId} className={labelClass}>Image description</label>
          <input
            id={altId}
            value={featuredAlt}
            onChange={(e) => api.patch({ featuredAlt: e.target.value })}
            maxLength={500}
            className={`${fieldClass} min-h-[var(--target-min)]`}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${altId}-h${error ? ` ${altId}-e` : ""}`}
          />
          <p id={`${altId}-h`} className={hintClass}>For people who can&rsquo;t see the image. You can save a draft without it, but it&rsquo;s needed to publish.</p>
          <FieldError id={`${altId}-e`} message={error} />
        </Group>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-[var(--space-xs)]">
          <p id={groupId} className={hintClass}>Or use an image from this article:</p>
          <ul aria-labelledby={groupId} className="grid grid-cols-3 gap-[var(--space-xs)]">
            {others.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  aria-label={`Use ${m.alt || "this image"} as the featured image`}
                  onClick={() => api.patch({ featured: m.id, featuredAlt: m.alt ?? "" })}
                  className="block w-full overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mediaUrl(m.id)} alt="" className="aspect-[4/3] w-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

/** The fields only the sidebar shows: the date, and search and sharing. */
export function MoreSettingsFields({ api, idPrefix }: { api: SettingsApi; idPrefix: string }) {
  const { meta, patch, errors } = api;
  const canonicalError = errors.canonical_url;
  const searchError = errors.seo_title ?? errors.seo_description ?? canonicalError;
  const [openSearch, setOpenSearch] = useState(false);
  return (
    <>
      <Group>
        <label htmlFor={`${idPrefix}-date`} className={labelClass}>First published (if elsewhere)</label>
        <input id={`${idPrefix}-date`} type="date" value={meta.originalDate} onChange={(e) => patch({ originalDate: e.target.value })} className={`${fieldClass} min-h-[var(--target-min)] focus-within:shadow-[var(--focus-ring)]`} aria-describedby={`${idPrefix}-date-h`} />
        <p id={`${idPrefix}-date-h`} className={hintClass}>Leave empty to use the date it goes live here.</p>
        <FieldError id={`${idPrefix}-date-e`} message={errors.original_published_at} />
      </Group>
      {/* Opens by itself when something inside it needs attention. */}
      <details open={openSearch || Boolean(searchError)} onToggle={(e) => setOpenSearch(e.currentTarget.open)} className="rounded-[var(--radius-input)] border border-[var(--color-border)] p-[var(--space-s)]">
        <summary className="min-h-[var(--target-min)] cursor-pointer py-[var(--space-xs)] font-medium">Search and sharing (optional)</summary>
        <div className="mt-[var(--space-s)] flex flex-col gap-[var(--space-m)]">
          <Group>
            <label htmlFor={`${idPrefix}-seot`} className={labelClass}>Search title</label>
            <input id={`${idPrefix}-seot`} value={meta.seoTitle} onChange={(e) => patch({ seoTitle: e.target.value })} maxLength={200} className={`${fieldClass} min-h-[var(--target-min)]`} placeholder="Leave empty to use the title" aria-invalid={errors.seo_title ? true : undefined} />
            <FieldError id={`${idPrefix}-seot-e`} message={errors.seo_title} />
          </Group>
          <Group>
            <label htmlFor={`${idPrefix}-seod`} className={labelClass}>Search description</label>
            <textarea id={`${idPrefix}-seod`} value={meta.seoDescription} onChange={(e) => patch({ seoDescription: e.target.value })} maxLength={320} rows={3} className={`${fieldClass} py-[var(--space-xs)]`} placeholder="Leave empty to use the subtitle" aria-invalid={errors.seo_description ? true : undefined} />
            <FieldError id={`${idPrefix}-seod-e`} message={errors.seo_description} />
          </Group>
          <Group>
            <label htmlFor={`${idPrefix}-canon`} className={labelClass}>Canonical address</label>
            <input id={`${idPrefix}-canon`} type="url" value={meta.canonicalUrl} onChange={(e) => patch({ canonicalUrl: e.target.value })} placeholder="https://" className={`${fieldClass} min-h-[var(--target-min)]`} aria-invalid={canonicalError ? true : undefined} aria-describedby={`${idPrefix}-canon-h`} />
            <p id={`${idPrefix}-canon-h`} className={hintClass}>Only if the definitive copy lives on another site. Usually empty.</p>
            <FieldError id={`${idPrefix}-canon-e`} message={canonicalError} />
          </Group>
        </div>
      </details>
    </>
  );
}
