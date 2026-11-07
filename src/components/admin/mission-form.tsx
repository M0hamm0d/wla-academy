"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, FormError, FormNotice, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { saveMissionAction } from "@/features/admin/actions";
import { emptyAdminState, type AdminFormState } from "@/features/admin/schemas";
import { cn } from "@/lib/utils";
import { MissionCoverField } from "./mission-cover-field";
import { useDirtyForm, useSubmitWithoutReset, UnsavedNote } from "./unsaved-changes";
import type { MissionRow } from "@/types/database";

const LABS = [
  ["challenge", "Challenge Lab"],
  ["decision", "Decision Lab"],
  ["curiosity", "Curiosity Lab"],
  ["wellbeing", "Wellbeing Lab"],
  ["navigation", "Navigation Lab"],
] as const;

const DELIVERY = [
  ["physical", "Physical"],
  ["hybrid", "Hybrid"],
  ["digital", "Digital"],
] as const;

/**
 * Mission catalogue and detail editing (CMS-01).
 *
 * Every field here is one the requirements name as editable. The fields that
 * are ABSENT are the point of the form: no slug, no version, no completion
 * rule, no screens. See `missionCatalogueSchema` for why each is excluded.
 */
export function MissionForm({
  mission,
  versionUsage,
}: {
  mission: MissionRow;
  versionUsage: { version: number; runs: number; complete: number }[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    saveMissionAction.bind(null, mission.slug),
    emptyAdminState,
  );

  const err = (name: string) => state.fieldErrors?.[name]?.[0];
  // Saving mid-upload would save the old cover and strand the new one.
  const [coverBusy, setCoverBusy] = useState(false);
  const { ref, dirty, saved } = useDirtyForm("details", "the mission details");
  const hasReturned = useRef(false);
  const submit = useSubmitWithoutReset(action);
  useEffect(() => {
    if (state.ok && !hasReturned.current) {
      hasReturned.current = true;
      saved();
      router.back();
    }
  }, [router, saved, state]);
  const liveRuns = versionUsage.filter((v) => v.runs > v.complete);

  return (
    <form ref={ref} action={action} onSubmit={submit} className="flex flex-col gap-[var(--space-xl)]">
      {state.ok && <FormNotice message={state.message} />}
      {!state.ok && state.message && <FormError message={state.message} />}

      <section className="flex flex-col gap-[var(--space-l)]">
        <h2 className="text-[length:var(--text-h3)]">Catalogue</h2>

        <Field label="Title" htmlFor="title" error={err("title")}>
          <Input
            id="title"
            name="title"
            defaultValue={mission.title}
            required
            invalid={Boolean(err("title"))}
          />
        </Field>

        <Field
          label="Catalogue description"
          htmlFor="description"
          hint="The short line shown on the public mission card and on Mission Home."
          error={err("description")}
        >
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={mission.description ?? ""}
            aria-invalid={Boolean(err("description")) || undefined}
            aria-describedby="description-hint"
            className={cn(
              "w-full rounded-[var(--radius-input)] border bg-[var(--color-surface)]",
              "px-[var(--space-m)] py-[var(--space-sm)] text-[length:var(--text-body)]",
              err("description")
                ? "border-[var(--color-error)]"
                : "border-[var(--color-border-strong)]",
            )}
          />
        </Field>

        <div className="grid gap-[var(--space-l)] sm:grid-cols-2">
          <Field label="Lab" htmlFor="lab" error={err("lab")}>
            <Select
              id="lab"
              name="lab"
              defaultValue={mission.lab}
              options={LABS}
            />
          </Field>
          <Field
            label="Delivery"
            htmlFor="delivery_type"
            error={err("delivery_type")}
          >
            <Select
              id="delivery_type"
              name="delivery_type"
              defaultValue={mission.delivery_type}
              options={DELIVERY}
            />
          </Field>
          <Field label="Minimum age" htmlFor="min_age" error={err("min_age")}>
            <Input
              id="min_age"
              name="min_age"
              type="number"
              min={4}
              max={18}
              defaultValue={mission.min_age}
              required
              invalid={Boolean(err("min_age"))}
            />
          </Field>
          <Field label="Maximum age" htmlFor="max_age" error={err("max_age")}>
            <Input
              id="max_age"
              name="max_age"
              type="number"
              min={4}
              max={18}
              defaultValue={mission.max_age}
              required
              invalid={Boolean(err("max_age"))}
            />
          </Field>
          <Field
            label="Mission time"
            htmlFor="duration"
            hint="As it should read, e.g. 60–75 mins."
            error={err("duration")}
          >
            <Input
              id="duration"
              name="duration"
              defaultValue={mission.duration ?? ""}
            />
          </Field>
        </div>
      </section>

      <hr className="wla-rule" />

      <MissionCoverField
        missionId={mission.id}
        savedValue={mission.cover_image}
        error={err("cover_image")}
        onBusyChange={setCoverBusy}
      />

      <hr className="wla-rule" />

      <section className="flex flex-col gap-[var(--space-l)]">
        <h2 className="text-[length:var(--text-h3)]">Access and price</h2>

        <div className="grid gap-[var(--space-l)] sm:grid-cols-2">
          <Field
            label="Price"
            htmlFor="price"
            hint="In pounds. Leave empty if the mission is not sold on its own."
            error={err("price_minor")}
          >
            <Input
              id="price"
              name="price"
              type="number"
              step="0.01"
              min="0"
              defaultValue={
                mission.price_minor === null
                  ? ""
                  : (mission.price_minor / 100).toFixed(2)
              }
              invalid={Boolean(err("price_minor"))}
            />
          </Field>
          <Field label="Currency" htmlFor="currency" error={err("currency")}>
            <Input
              id="currency"
              name="currency"
              defaultValue={mission.currency}
              maxLength={3}
              invalid={Boolean(err("currency"))}
            />
          </Field>
        </div>

        <Checkbox
          name="is_free"
          defaultChecked={mission.is_free}
          label="Free mission"
          hint="A free mission still grants access through the same server-side entitlement as a purchase."
        />

        <Checkbox
          name="published"
          defaultChecked={mission.published}
          label="Show in catalogue (available to buy)"
          hint="Shown missions appear in the public catalogue and can be bought. Hidden missions stay reachable for anyone already entitled. This is separate from publishing a version: it doesn't change which version learners get."
        />
      </section>

      {/*
        D-17 MADE VISIBLE.

        Editing catalogue content cannot disturb a run in flight — the version
        and the completion rule are both snapshotted onto each run when it
        starts. Saying so here, with the actual counts, is more use than saying
        it in a document nobody has open at the time.
      */}
      {versionUsage.length > 0 && (
        <section className="wla-measure rounded-[var(--radius-surface)] bg-[var(--color-surface-sage)] p-[var(--space-l)]">
          <h2 className="text-[length:var(--text-h3)]">Runs in progress</h2>
          <ul className="mt-[var(--space-s)] flex flex-col gap-[var(--space-xs)]">
            {versionUsage.map((v) => (
              <li key={v.version}>
                Version {v.version}: {v.runs} run{v.runs === 1 ? "" : "s"}
                {v.complete > 0 && `, ${v.complete} complete`}
              </li>
            ))}
          </ul>
          <p className="mt-[var(--space-m)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
            {liveRuns.length > 0
              ? "Children partway through keep the version they started on, and the wording they began with. Saving here changes the catalogue, not their mission."
              : "Nothing is partway through. Saving here changes the catalogue only."}
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-[var(--space-l)]">
        <Button type="submit" size="large" isLoading={pending} disabled={coverBusy}>
          Save changes
        </Button>
        <UnsavedNote dirty={dirty} />
      </div>
    </form>
  );
}

function Select({
  id,
  name,
  defaultValue,
  options,
}: {
  id: string;
  name: string;
  defaultValue: string;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <select
      id={id}
      name={name}
      defaultValue={defaultValue}
      className={cn(
        "min-h-[var(--target-min)] w-full rounded-[var(--radius-input)]",
        "border border-[var(--color-border-strong)] bg-[var(--color-surface)]",
        "px-[var(--space-m)] text-[length:var(--text-body)]",
      )}
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** A real checkbox with a real label — never a styled div (UI/UX §51). */
function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
}) {
  return (
    <div className="flex flex-col gap-[var(--space-xs)]">
      {/*
        The whole row is the target: the box alone is 24px, the WCAG floor,
        but CLAUDE.md asks for 44px on every interactive element, so the label
        wraps the box and carries the min-height.
      */}
      <label className="inline-flex min-h-[var(--target-min)] cursor-pointer items-center gap-[var(--space-m)] self-start">
        <input
          name={name}
          type="checkbox"
          defaultChecked={defaultChecked}
          className="size-6 shrink-0 accent-[var(--color-primary)]"
          aria-describedby={`${name}-hint`}
        />
        <span className="text-[length:var(--text-label)] font-medium">{label}</span>
      </label>
      <span
        id={`${name}-hint`}
        className="wla-measure pl-[calc(1.5rem+var(--space-m))] text-[length:var(--text-small)] text-[var(--color-text-muted)]"
      >
        {hint}
      </span>
    </div>
  );
}
