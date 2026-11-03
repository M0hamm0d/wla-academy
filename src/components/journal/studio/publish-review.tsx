"use client";

import { useId, useRef, useState } from "react";

import { Dialog } from "@/components/admin/dialog";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { publishAction, scheduleAction, type JournalState } from "@/features/journal/actions";
import { publishProblems, type PublishProblem } from "@/features/journal/publish-check";
import { formatLondon, JOURNAL_TIME_ZONE, londonWallTimeToUtc } from "@/features/journal/time";
import {
  CategoryField, ExcerptField, FeaturedImageField, SlugField, TagsField,
  fieldClass, hintClass, labelClass, type SettingsApi,
} from "./article-settings";

export type PublishOutcome = "published" | "updated" | "scheduled";

/**
 * REVIEW BEFORE PUBLISHING (D-147, amends D-137).
 *
 * Opening this changes nothing. It shows what is about to go live and lets it be
 * corrected here: every field is the studio's own state, so going back to the
 * editor loses nothing and there is no second copy. Only the final button acts.
 * Anything unsaved is saved first, then exactly that saved version is published.
 * The studio moves on only once the server has said yes.
 */
export function PublishReview({
  open, onBack, onFocusEditor, onDone, api, articleId, isUpdate, title, setTitle, body, dirty,
  pendingUploads, revisionId, liveRevisionId, contentHash, saveNow, scheduler,
}: {
  open: boolean;
  onBack: () => void;
  onFocusEditor: () => void;
  onDone: (outcome: PublishOutcome) => void;
  api: SettingsApi;
  articleId: string;
  isUpdate: boolean;
  title: string;
  setTitle: (v: string) => void;
  body: string;
  dirty: boolean;
  pendingUploads: number;
  revisionId: string;
  liveRevisionId: string | null;
  contentHash: string;
  saveNow: () => Promise<JournalState>;
  scheduler: { configured: boolean; active: boolean; overdue: number } | null;
}) {
  const uid = useId();
  const idPrefix = `${uid}-review`;
  const [when, setWhen] = useState<"now" | "later">("now");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  // Repeated clicks land before React re-renders the disabled button.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | undefined>();
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const preview = local ? londonWallTimeToUtc(local) : null;

  const { meta } = api;
  const problems = publishProblems({
    title, body, slug: meta.slug, featured: meta.featured, featuredAlt: meta.featuredAlt, pendingUploads,
  });
  const problemFor = (field: PublishProblem["field"]) => problems.find((x) => x.field === field)?.message;
  const nothingNew = Boolean(liveRevisionId && !dirty && revisionId === liveRevisionId);
  const imagesWithoutAlt = (body.match(/<img\b[^>]*>/g) ?? []).filter((t) => !/\salt="[^"]+"/.test(t)).length;
  const healthy = !scheduler || (scheduler.configured && scheduler.active && scheduler.overdue === 0);

  const reviewApi: SettingsApi = {
    ...api,
    errors: {
      ...api.errors,
      ...serverErrors,
      slug: problemFor("slug") ?? serverErrors.slug ?? api.errors.slug,
      featured_alt: problemFor("featured_alt") ?? serverErrors.featured_alt ?? api.errors.featured_alt,
    },
  };
  const titleError = problemFor("title") ?? api.errors.title;

  /** Take the person to what needs fixing: here if it's here, else the editor. */
  const fix = (p: PublishProblem) => {
    if (p.field === "body" || p.field === "uploads") return onFocusEditor();
    const id = { title: "title", slug: "slug", featured_alt: "falt" }[p.field];
    document.getElementById(`${idPrefix}-${id}`)?.focus();
  };

  const go = async () => {
    if (inFlight.current) return;
    setError(undefined);
    setServerErrors({});
    if (when === "later" && !preview?.ok) {
      setError(preview && !preview.ok && preview.reason === "nonexistent" ? "That time doesn't exist in the UK (the clocks go forward). Choose another." : "Choose a date and time.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const stop = (message?: string) => {
      inFlight.current = false;
      setBusy(false);
      setError(message);
    };

    let rev = revisionId;
    let hash = contentHash;
    if (dirty) {
      const s = await saveNow();
      if (!s.ok) {
        return stop(s.error ?? (s.fieldErrors ? "Please correct the marked details. Nothing has been published." : "Saving failed, so nothing was published."));
      }
      rev = s.revisionId ?? rev;
      hash = s.contentHash ?? hash;
    }

    const fd = new FormData();
    fd.set("articleId", articleId);
    fd.set("revisionId", rev);
    fd.set("contentHash", hash);
    if (when === "later") fd.set("atLocal", local);
    let r: JournalState;
    try {
      r = await (when === "now" ? publishAction({}, fd) : scheduleAction({}, fd));
    } catch {
      return stop("We couldn't get an answer from the server, so we can't say this went through. Your work is saved here. Check your connection and try again.");
    }
    if (!r.ok) {
      setServerErrors(r.fieldErrors ?? {});
      return stop(r.error ?? Object.values(r.fieldErrors ?? {})[0] ?? "That didn't work. Please try again.");
    }
    // Stays busy: the page is leaving, and nothing here should be pressed again.
    onDone(when === "later" ? "scheduled" : isUpdate ? "updated" : "published");
  };

  const verb = isUpdate ? "Update" : "Publish";
  return (
    <Dialog open={open} onClose={() => { if (!busy) onBack(); }} title={isUpdate ? "Review Before Updating" : "Review Before Publishing"} size="wide">
      <div className="flex flex-col gap-[var(--space-l)]">
        <p className={hintClass}>
          {isUpdate
            ? "You're updating an article that's already published. Readers keep the current version until you choose Update Article."
            : "Check the details below and change anything here. Nothing is published until you choose Publish Article."}
        </p>

        {nothingNew && <p role="note">This version is already published. Change something to update it.</p>}

        {problems.length > 0 && (
          <div role="alert" className="rounded-[var(--radius-input)] border-2 border-[var(--color-error)] bg-[var(--color-surface)] p-[var(--space-s)]">
            <p className="font-medium">Before it can be {isUpdate ? "updated" : "published"}:</p>
            <ul className="mt-[var(--space-xs)] flex flex-col gap-[var(--space-xs)]">
              {problems.map((x) => (
                <li key={x.field} className="flex flex-wrap items-center justify-between gap-x-[var(--space-m)]">
                  <span>{x.message}</span>
                  <button type="button" onClick={() => fix(x)} className="min-h-[var(--target-min)] rounded-[var(--radius-control)] px-[var(--space-xs)] text-[length:var(--text-small)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]">
                    {x.field === "body" || x.field === "uploads" ? "Go to the article" : "Go to this field"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <section aria-labelledby={`${uid}-a`} className="flex flex-col gap-[var(--space-m)]">
          <h3 id={`${uid}-a`} className="text-[length:var(--text-body-lg)] font-semibold">Article information</h3>
          <div className="flex flex-col gap-[var(--space-xs)]">
            <label htmlFor={`${idPrefix}-title`} className={labelClass}>Title</label>
            <input
              id={`${idPrefix}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              className={`${fieldClass} min-h-[var(--target-min)]`}
              aria-invalid={titleError ? true : undefined}
            />
            {titleError && <p className="text-[length:var(--text-small)] text-[var(--color-error)]">{titleError}</p>}
          </div>
          <ExcerptField api={reviewApi} idPrefix={idPrefix} />
          <FeaturedImageField api={reviewApi} idPrefix={idPrefix} />
        </section>

        <section aria-labelledby={`${uid}-d`} className="flex flex-col gap-[var(--space-m)] border-t border-[var(--color-border)] pt-[var(--space-l)]">
          <h3 id={`${uid}-d`} className="text-[length:var(--text-body-lg)] font-semibold">Publishing details</h3>
          <SlugField api={reviewApi} idPrefix={idPrefix} />
          <CategoryField api={reviewApi} idPrefix={idPrefix} />
          <TagsField api={reviewApi} idPrefix={idPrefix} />
          {(meta.authorName || meta.originalDate) && (
            <dl className={`grid grid-cols-[auto_1fr] gap-x-[var(--space-m)] gap-y-[var(--space-xs)] ${hintClass}`}>
              {meta.authorName && <><dt>Author</dt><dd>{meta.authorName}</dd></>}
              {meta.originalDate && <><dt>First published</dt><dd>{meta.originalDate}</dd></>}
            </dl>
          )}

          <fieldset className="flex flex-col gap-[var(--space-xs)]">
            <legend className={`${labelClass} mb-[var(--space-xs)]`}>When</legend>
            <label className="flex min-h-[var(--target-min)] items-center gap-[var(--space-s)]">
              <input type="radio" name={`${uid}-when`} checked={when === "now"} onChange={() => setWhen("now")} className="h-5 w-5 accent-[var(--color-primary)]" />
              Now
            </label>
            <label className="flex min-h-[var(--target-min)] items-center gap-[var(--space-s)]">
              <input type="radio" name={`${uid}-when`} checked={when === "later"} onChange={() => setWhen("later")} className="h-5 w-5 accent-[var(--color-primary)]" />
              At a later time
            </label>
          </fieldset>
          {when === "later" && (
            <div className="flex flex-col gap-[var(--space-xs)]">
              <label htmlFor={`${uid}-at`} className={labelClass}>Date and time — UK time ({JOURNAL_TIME_ZONE})</label>
              <input
                id={`${uid}-at`}
                type="datetime-local"
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                aria-describedby={`${uid}-at-h ${uid}-at-p`}
                className={`${fieldClass} min-h-[var(--target-min)] max-w-[18rem] focus-within:shadow-[var(--focus-ring)]`}
              />
              <p id={`${uid}-at-h`} className={hintClass}>Always UK time, whatever your device says. It publishes by itself at that moment — nobody needs to be online.</p>
              <p id={`${uid}-at-p`} role="status" className="text-[length:var(--text-small)]">
                {preview?.ok ? `= ${formatLondon(preview.utc)}${preview.ambiguous ? " — the first of the two 01:00 hours as the clocks go back" : ""}` : ""}
              </p>
              {!healthy && (
                <p role="alert" className="rounded-[var(--radius-input)] border border-[var(--color-error)] p-[var(--space-s)] text-[length:var(--text-small)]">
                  Automatic publishing isn&rsquo;t running right now, so a scheduled article may not publish on time.
                </p>
              )}
            </div>
          )}
          {imagesWithoutAlt > 0 && (
            <p className="rounded-[var(--radius-input)] border border-[var(--color-border-strong)] p-[var(--space-s)] text-[length:var(--text-small)]">
              {imagesWithoutAlt === 1 ? "One image in the article has" : `${imagesWithoutAlt} images in the article have`} no description for people who can&rsquo;t see it. You can still go ahead; select an image in the editor to add one.
            </p>
          )}
          {!nothingNew && dirty && <p className={hintClass}>Your unsaved changes are saved first.</p>}
        </section>

        <div className="sticky bottom-[calc(-1*var(--space-l))] -mx-[var(--space-l)] -mb-[var(--space-l)] flex flex-col gap-[var(--space-s)] border-t border-[var(--color-border)] bg-[var(--color-background)] px-[var(--space-l)] py-[var(--space-m)]">
          <FormError message={error} />
          <div className="flex flex-wrap justify-between gap-[var(--space-s)]">
            <Button type="button" variant="secondary" onClick={onBack} disabled={busy}>Back to Editing</Button>
            {!nothingNew && (
              <Button
                type="button"
                onClick={go}
                disabled={problems.length > 0}
                isLoading={busy}
                loadingLabel={when === "later" ? "Scheduling…" : isUpdate ? "Updating…" : "Publishing…"}
              >
                {when === "later" ? "Schedule Article" : `${verb} Article`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
