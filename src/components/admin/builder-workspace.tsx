"use client";

import { PrintChecklist } from "./print-checklist";
import { PatternPicker } from "./pattern-picker";
import Link from "next/link";
import { AssetManager } from "./asset-manager";
import type { ResolvedAsset } from "@/features/mission-engine/media";
import { useActionState, useEffect, useRef, useState } from "react";
import { ScreenEditor, type EditableScreen } from "./screen-editor";
import { KitEditor, ParentNoteEditor, type DraftResource } from "./kit-editor";
import { DefinitionEditor } from "./definition-editor";
import { FlowMap } from "./flow-map";
import { VocabularyProvider } from "./schema-form";
import { CompletionPanel } from "./completion-panel";
import { PublishPanel } from "./publish-panel";
import { SectionHeader } from "./section-header";
import { useUnsavedChanges } from "./unsaved-changes";
import { emptyDefinition, type MissionDefinition } from "@/features/mission-engine/definition";
import { screenCatalog } from "@/features/mission-engine/interactions/catalog";
import { readinessChecks, SECTIONS, sectionOf, type BuilderFacts, type ReadinessCheck } from "@/features/admin/builder-readiness";
import { deleteScreenAction, moveScreenAction, type BuilderState } from "@/features/admin/builder-actions";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/field";
import { cn } from "@/lib/utils";

const initial: BuilderState = {};

type Problem = {
  code: string;
  blocking: boolean;
  screen_key: string | null;
  detail: string;
  category?: string;
};

/** "Decision — one choice, branches" → "Decision". */
const typeName = (type: string) => screenCatalog.find((e) => e.type === type)?.label.split(" — ")[0] ?? type.replace(/_/g, " ");

const linkCls = "inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-small)] underline decoration-[var(--color-border-strong)] underline-offset-4";

/**
 * The builder workspace: every section of one draft version.
 *
 * NOT A WIZARD. Sections can be worked on in any order; the index at the top
 * of the page links to each, with a status from the automated checks (D-116).
 *
 * VALIDATION IS SHOWN, NOT ENFORCED HERE. Publishing is refused by
 * `set_mission_version_status`, which re-runs `validate_mission_version`
 * inside the same transaction. This panel exists so an author can see what is
 * wrong and go straight to it; it is not what stops a bad version going out.
 */
export function BuilderWorkspace({
  missionId,
  slug,
  version,
  status,
  completionRule,
  screens,
  blocking,
  advisory,
  resources,
  noteContent,
  noteDocumentPath,
  noteDocumentUrl,
  paths = [],
  definition = null,
  assets = { rows: [], resolved: [] },
  checklist = null,
  facts,
  publishImpact = [],
}: {
  missionId: string;
  slug: string;
  version: number;
  status: string;
  completionRule: unknown;
  screens: EditableScreen[];
  blocking: Problem[];
  advisory: Problem[];
  resources: DraftResource[];
  noteContent: string | null;
  noteDocumentPath: string | null;
  noteDocumentUrl: string | null;
  /** Every route the QA simulator played (validator.ts). */
  paths?: { decisions: string[]; screens: string[]; outcome: string; detail: string | null }[];
  /** The draft's mission definition (F8), for the logic editor and form vocabulary. */
  definition?: MissionDefinition | null;
  /** F7 — this draft's media, signed with the admin's own session. */
  assets?: { rows: { key: string; kind: string; storage_path: string; captions_path: string | null }[]; resolved: ResolvedAsset[] };
  /** Plan §12 print-resource checklist, computed from the draft. */
  checklist?: ReturnType<typeof import("@/features/admin/print-checklist").printChecklist> | null;
  /** What the readiness checklist is computed from (builder-readiness.ts). */
  facts: BuilderFacts;
  /** The publish confirmation's sentences (mission-status.ts `publishImpact`). */
  publishImpact?: string[];
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Where to scroll once the editor it names has rendered.
  const pendingScroll = useRef<string | null>(null);
  const { requestDiscard } = useUnsavedChanges();

  const nextSequence = screens.length
    ? Math.max(...screens.map((s) => s.sequence)) + 10
    : 10;

  const titles = new Map(screens.map((s) => [s.screen_key, s.title || s.screen_key]));
  const nameOf = (key: string | null) => (key ? (titles.get(key) ?? key) : null);

  const problemsByScreen = new Map<string, Problem[]>();
  for (const p of [...blocking, ...advisory]) {
    if (!p.screen_key) continue;
    problemsByScreen.set(p.screen_key, [...(problemsByScreen.get(p.screen_key) ?? []), p]);
  }

  const def = definition ?? emptyDefinition;
  const vocabulary = {
    screens: screens.map((x) => x.screen_key),
    screenTitles: Object.fromEntries(screens.map((x) => [x.screen_key, x.title ?? ""])),
    variables: def.variables.map((v) => v.key),
    unlocks: def.unlocks.map((u) => u.key),
    events: def.events.map((e) => e.key),
    assets: [] as string[],
  };

  /** Whatever editor is open — the only forms a switch would close. */
  const openEditors = [...(editing ? [`screen:${editing}`] : []), ...(adding ? ["screen:new"] : [])];

  /** Open one screen's editor, asking first if another has unsaved changes. */
  function openScreen(key: string) {
    if (editing === key) { pendingScroll.current = key; scrollPending(); return; }
    requestDiscard(openEditors, () => {
      pendingScroll.current = key;
      setAdding(false);
      setEditing(key);
    });
  }

  function startAdding() {
    requestDiscard(openEditors, () => { pendingScroll.current = "__new"; setEditing(null); setAdding(true); });
  }

  function scrollPending() {
    const target = pendingScroll.current;
    if (!target) return;
    const el = document.getElementById(target === "__new" ? "new-screen" : `screen-${target}`);
    if (!el) return; // not rendered yet — e.g. a just-added screen still arriving
    el.scrollIntoView?.({ block: "start" });
    const focusable = el.querySelector<HTMLElement>("input:not([type=hidden]):not([readonly]), select, textarea");
    focusable?.focus({ preventScroll: true });
    pendingScroll.current = null;
  }
  useEffect(scrollPending);

  // A pattern added from the empty state unmounts the picker with its notice;
  // say it here instead.
  const [prevCount, setPrevCount] = useState(screens.length);
  if (prevCount !== screens.length) {
    setPrevCount(screens.length);
    if (prevCount === 0 && screens.length > 1) {
      setFlash("Pattern added. Replace the text in [square brackets] with your own, then check the Flow map below.");
    }
  }

  const checks = readinessChecks(facts);
  const required = checks.filter((c) => c.level === "required");
  const recommended = checks.filter((c) => c.level === "recommended");

  return (
    <VocabularyProvider value={vocabulary}>
      {/* ------------------------------------------------- screens and flow */}
      <section className="mt-[var(--space-2xl)]" aria-labelledby="builder-screens">
        <SectionHeader
          id="builder-screens"
          title="Screens & flow"
          purpose="The steps a child moves through, in order, ending on a completion screen."
          more={
            <>
              <p>Each screen is one step: reading, choosing, making something, going off to do something physical, or reflecting. A decision screen branches; each option says which screen it leads to.</p>
              <p className="mt-[var(--space-xs)]">Use the arrows to reorder, and <em>Preview from here</em> to try a screen as a learner. Nothing you do in preview is saved.</p>
            </>
          }
          helpAnchor="building"
          action={screens.length > 0 ? (
            <Button type="button" variant="text" onClick={() => (adding ? requestDiscard(["screen:new"], () => setAdding(false)) : startAdding())}>
              {adding ? "Cancel adding" : "Add a screen"}
            </Button>
          ) : undefined}
        />

        {flash && <div className="mt-[var(--space-m)]"><FormNotice message={flash} /></div>}

        {screens.length === 0 && !adding ? (
          <div className="mt-[var(--space-m)] rounded-[var(--radius-surface)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-l)]">
            <h3 className="text-[length:var(--text-h3)]">Start building the mission</h3>
            <p className="mt-[var(--space-xs)] wla-measure text-[var(--color-text-muted)]">
              A mission is a sequence of screens — the steps a child moves through — ending on a completion screen.
              Choose how to begin. Nothing is created until you confirm.
            </p>
            <div className="mt-[var(--space-l)] grid gap-[var(--space-l)] md:grid-cols-2">
              {/* <div>
                <h4 className="font-medium">Start from a proven pattern</h4>
                <p className="mt-[2px] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                  A ready-made structure from earlier WLA missions — its screens, branches and handoffs — that you then
                  rewrite in your own words.
                </p>
                <PatternPicker missionId={missionId} slug={slug} version={version} suggestedPrefix="part1_" open />
              </div> */}
              <div>
                <h4 className="font-medium">Add your first screen</h4>
                <p className="mt-[2px] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                  Build it one step at a time. Each screen has a title, what the child does there, and where it leads.
                </p>
                <div className="mt-[var(--space-m)]">
                  <Button type="button" variant="secondary" onClick={startAdding}>Add your first screen</Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {adding && (
          <div id="new-screen" className="mt-[var(--space-m)] scroll-mt-[var(--space-xl)] rounded-[var(--radius-surface)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-[var(--space-m)]">
            <h3 className="mb-[var(--space-m)] text-[length:var(--text-label)] font-medium">New screen</h3>
            <ScreenEditor
              missionId={missionId}
              slug={slug}
              version={version}
              screen={null}
              nextSequence={nextSequence}
              existingKeys={screens.map((s) => s.screen_key)}
              onDone={() => setAdding(false)}
              onAdded={(key) => {
                pendingScroll.current = key;
                setAdding(false);
                setEditing(key);
                setFlash("Screen added. Its editor is open below so you can carry on.");
              }}
            />
          </div>
        )}

        {screens.length > 0 && (
          <ol className="mt-[var(--space-m)] flex flex-col gap-[var(--space-s)]">
            {screens.map((s, i) => {
              const problems = problemsByScreen.get(s.screen_key) ?? [];
              const hasBlocking = problems.some((p) => p.blocking);
              return (
                <li
                  key={s.screen_key}
                  id={`screen-${s.screen_key}`}
                  className={cn(
                    "scroll-mt-[var(--space-xl)] rounded-[var(--radius-surface)] border bg-[var(--color-surface)] p-[var(--space-m)]",
                    hasBlocking ? "border-[var(--color-error)]" : "border-[var(--color-border)]",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-[var(--space-s)]">
                    <div className="min-w-0">
                      <p className="font-medium">
                        <span className="text-[var(--color-text-muted)]">{i + 1}.</span>{" "}
                        {s.title || <span className="italic">Untitled ({s.screen_key})</span>}
                      </p>
                      <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                        {typeName(s.type)}
                        {s.title ? <> · <span className="break-all">{s.screen_key}</span></> : null}
                      </p>
                      {problems.map((p, n) => (
                        <p
                          key={`${p.code}-${n}`}
                          className={cn(
                            "mt-[var(--space-xs)] text-[length:var(--text-small)]",
                            p.blocking ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]",
                          )}
                        >
                          <strong>{p.blocking ? "Must fix: " : "Suggestion: "}</strong>{p.detail}
                        </p>
                      ))}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-xs)]">
                      <MoveButton missionId={missionId} slug={slug} version={version}
                        screenKey={s.screen_key} label={s.title || s.screen_key} direction="up" disabled={i === 0} />
                      <MoveButton missionId={missionId} slug={slug} version={version}
                        screenKey={s.screen_key} label={s.title || s.screen_key} direction="down" disabled={i === screens.length - 1} />
                      <button
                        type="button"
                        aria-expanded={editing === s.screen_key}
                        aria-label={`${editing === s.screen_key ? "Close" : "Edit"} ${s.title || s.screen_key}`}
                        onClick={() => (editing === s.screen_key
                          ? requestDiscard([`screen:${s.screen_key}`], () => setEditing(null))
                          : openScreen(s.screen_key))}
                        className="min-h-[var(--target-min)] px-[var(--space-xs)] text-[length:var(--text-small)] underline decoration-[var(--color-border-strong)] underline-offset-4"
                      >
                        {editing === s.screen_key ? "Close" : "Edit"}
                      </button>
                      <a href={`/admin/builder/${slug}/${version}/preview?from=${encodeURIComponent(s.screen_key)}`} aria-label={`Preview from here: ${s.title || s.screen_key}`} className={cn(linkCls, "px-[var(--space-xs)]")}>
                        Preview from here
                      </a>
                      <DeleteScreenButton missionId={missionId} slug={slug} version={version} screenKey={s.screen_key} label={s.title || s.screen_key} />
                    </div>
                  </div>

                  {editing === s.screen_key && (
                    <div className="mt-[var(--space-m)] border-t border-[var(--color-border)] pt-[var(--space-m)]">
                      <ScreenEditor
                        missionId={missionId}
                        slug={slug}
                        version={version}
                        screen={s}
                        nextSequence={nextSequence}
                        onDone={() => setEditing(null)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {/* ---------------------------------------------------- flow map (§12) */}
        <FlowMap
          screens={screens.map((x) => ({ screen_key: x.screen_key, type: x.type, title: x.title, sequence: x.sequence, configuration: x.configuration }))}
          events={def.events.map((e) => ({ key: e.key, goto: e.goto }))}
          flagged={blocking.map((p) => p.screen_key).filter((k): k is string => Boolean(k))}
          unreachable={blocking.filter((p) => p.code === "unreachable_screen").map((p) => p.screen_key).filter((k): k is string => Boolean(k))}
          onOpenScreen={openScreen}
        />

        {screens.length > 0 && (
          <PatternPicker missionId={missionId} slug={slug} version={version} suggestedPrefix={`part${Math.floor(nextSequence / 100) + 1}_`} />
        )}
      </section>

      {/* ------------------------------------------------- mission logic (F8) */}
      <DefinitionEditor
        missionId={missionId} slug={slug} version={version} definition={def}
        attention={blocking.filter((p) => sectionOf(p) === "logic").length}
      />
      {def.qr.length > 0 && (
        <p className="mt-[var(--space-s)]">
          <Link href={`/admin/builder/${slug}/${version}/qr`}
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4">
            Print the QR codes ({def.qr.length})
          </Link>
        </p>
      )}

      <AssetManager missionId={missionId} slug={slug} version={version} rows={assets.rows} resolved={assets.resolved} />

      {/* --------------------------------------------- Mission Kit, For Parents */}
      <section className="mt-[var(--space-2xl)]" aria-labelledby="builder-kit">
        <SectionHeader
          id="builder-kit"
          title="Kit & For Parents"
          purpose="What WLA gives the family with this mission, and the note for the adult helping."
          more={
            <>
              <p><strong>Mission Kit</strong> is what WLA gives: printables and resources. Opening or printing them never changes a child&rsquo;s progress.</p>
              <p className="mt-[var(--space-xs)]"><strong>For Parents</strong> is adult guidance, never shown to the child.</p>
              <p className="mt-[var(--space-xs)]">Neither is the <strong>Mission Trail</strong>, which is what the child makes along the way and is configured on screens.</p>
            </>
          }
          helpAnchor="kit-trail"
        />
        {checklist && <PrintChecklist rows={checklist.rows} missing={checklist.missing} />}
        <KitEditor missionId={missionId} slug={slug} version={version} resources={resources} />
        <ParentNoteEditor
          missionId={missionId} slug={slug} version={version}
          content={noteContent} documentPath={noteDocumentPath}
          documentUrl={noteDocumentUrl}
        />
      </section>

      {/* ------------------------------------------------------- completion */}
      <CompletionPanel
        missionId={missionId} slug={slug} version={version} rule={completionRule}
        definitionCompletion={def.completion}
        screens={screens.map((s) => ({ screen_key: s.screen_key, title: s.title, type: s.type }))}
      />

      {/* -------------------------------------------------- review & publish */}
      <section className="mt-[var(--space-2xl)]" aria-labelledby="builder-review">
        <SectionHeader
          id="builder-review"
          title="Review & publish"
          purpose="Whether this version is ready, and putting it live for new learners."
          more={<p>The automatic checks look for anything that would strand a learner — a choice leading nowhere, a screen nothing reaches, no way to finish. Publishing is refused while any remain. Suggestions never block publishing.</p>}
          helpAnchor="publishing"
          action={
            <a href={`/admin/builder/${slug}/${version}/preview`} className="inline-flex min-h-[var(--target-min)] items-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-[var(--space-l)] text-[length:var(--text-label)] hover:border-[var(--color-border-strong)]">
              Preview as a learner
            </a>
          }
        />

        <div className="mt-[var(--space-m)]">
          {required.length === 0 ? (
            <p className="wla-measure">
              {screens.length === 0 ? "Add screens to start the checks." : "The automatic checks found nothing that blocks publishing."}
            </p>
          ) : (
            <>
              <h3 className="text-[length:var(--text-label)] font-medium">
                Must fix before publishing ({required.length})
              </h3>
              <p className="wla-measure text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                Each of these would stop a learner finishing the mission.
              </p>
              <CheckGroups checks={required} nameOf={nameOf} onOpenScreen={openScreen} level={4} />
            </>
          )}

          {recommended.length > 0 && (
            <details className="mt-[var(--space-l)]">
              <summary className="inline-flex min-h-[var(--target-min)] cursor-pointer items-center text-[length:var(--text-label)] font-medium">
                Suggestions ({recommended.length}) — worth a look, never blocking
              </summary>
              {/* The summary is not a heading, so these sit directly under the section's h2. */}
              <CheckGroups checks={recommended} nameOf={nameOf} onOpenScreen={openScreen} level={3} />
            </details>
          )}

          {/*
            BRANCH TESTING — every route the automated QA played through the
            real runtime. A route that does not reach Complete is a blocking
            problem above; this shows the whole picture.
          */}
          {paths.length > 0 && (
            <details className="mt-[var(--space-l)]">
              <summary className="inline-flex min-h-[var(--target-min)] cursor-pointer items-center text-[length:var(--text-label)] font-medium">
                Branch test: {paths.filter((p) => p.outcome === "complete").length} of {paths.length} routes reach the end
              </summary>
              <p className="wla-measure text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                Every combination of choices, played automatically through the real mission engine.
              </p>
              <ol className="mt-[var(--space-s)] flex flex-col gap-[var(--space-xs)]">
                {paths.map((p, i) => (
                  <li key={i} className="text-[length:var(--text-small)]">
                    <strong>{p.outcome === "complete" ? "Reaches the end" : "Does not reach the end"}</strong>
                    {p.decisions.length ? ` — ${p.decisions.join(" → ")}` : ""}
                    <span className="text-[var(--color-text-muted)]"> · {p.screens.length} screens{p.detail ? ` · ${p.detail}` : ""}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}

          <PublishPanel
            missionId={missionId} slug={slug} version={version} status={status}
            blockingCount={blocking.length} advisoryCount={advisory.length}
            impact={publishImpact}
          />
        </div>
      </section>
    </VocabularyProvider>
  );
}

/** Readiness items grouped by section, each with a way to it. */
function CheckGroups({
  checks, nameOf, onOpenScreen, level,
}: {
  checks: ReadinessCheck[];
  nameOf: (key: string | null) => string | null;
  onOpenScreen: (key: string) => void;
  /** The group label's heading level, so the outline never skips one. */
  level: 3 | 4;
}) {
  const Heading = level === 3 ? "h3" : "h4";
  return (
    <div className="mt-[var(--space-s)] flex flex-col gap-[var(--space-m)]">
      {SECTIONS.filter((s) => checks.some((c) => c.section === s.id)).map((s) => (
        <div key={s.id}>
          <Heading className="text-[length:var(--text-small)] font-medium text-[var(--color-text-muted)]">{s.label}</Heading>
          <ul className="mt-[2px] flex flex-col gap-[var(--space-xs)]">
            {checks.filter((c) => c.section === s.id).map((c, i) => (
              <li key={i} className="text-[length:var(--text-label)]">
                {c.screenKey && <strong>{nameOf(c.screenKey)}: </strong>}
                {c.text}
                {c.why && <span className="block text-[length:var(--text-small)] text-[var(--color-text-muted)]">{c.why}</span>}
                {c.screenKey && nameOf(c.screenKey) ? (
                  <Button type="button" variant="text" className="px-0 text-[length:var(--text-small)]" aria-label={`Open this screen: ${nameOf(c.screenKey)}`} onClick={() => onOpenScreen(c.screenKey!)}>
                    Open this screen
                  </Button>
                ) : s.id !== "review" ? (
                  <a href={`#${s.anchor}`} className={linkCls}>Go to {s.label}</a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function MoveButton({
  missionId, slug, version, screenKey, label, direction, disabled,
}: {
  missionId: string; slug: string; version: number;
  screenKey: string; label: string; direction: "up" | "down"; disabled: boolean;
}) {
  return (
    <form action={moveScreenAction}>
      <input type="hidden" name="missionId" value={missionId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="screen_key" value={screenKey} />
      <input type="hidden" name="direction" value={direction} />
      <button
        type="submit"
        disabled={disabled}
        aria-label={`Move “${label}” ${direction}`}
        className="inline-flex size-[var(--target-min)] items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {direction === "up" ? <path d="m6 14 6-6 6 6" /> : <path d="m6 10 6 6 6-6" />}
        </svg>
      </button>
    </form>
  );
}

function DeleteScreenButton({
  missionId, slug, version, screenKey, label,
}: {
  missionId: string; slug: string; version: number; screenKey: string; label: string;
}) {
  const [armed, setArmed] = useState(false);
  const [state, action, pending] = useActionState(deleteScreenAction, initial);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        aria-label={`Remove ${label}`}
        className="min-h-[var(--target-min)] px-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)] underline decoration-[var(--color-border)] underline-offset-4"
      >
        Remove
      </button>
    );
  }

  return (
    <form action={action} className="flex items-center gap-[var(--space-xs)]">
      <input type="hidden" name="missionId" value={missionId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="screen_key" value={screenKey} />
      {state.error && <span className="text-[length:var(--text-small)] text-[var(--color-error)]">{state.error}</span>}
      <button type="submit" disabled={pending} className="min-h-[var(--target-min)] text-[length:var(--text-small)] font-medium text-[var(--color-error)] underline underline-offset-4">
        {pending ? "Removing…" : `Remove “${label}”`}
      </button>
      <button type="button" onClick={() => setArmed(false)} className="min-h-[var(--target-min)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        Cancel
      </button>
    </form>
  );
}
