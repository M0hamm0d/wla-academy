"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { RevealedCode } from "@/components/child/revealed-code";
import {
  createChildAction,
  updateChildAction,
  type CreateChildState,
} from "@/features/children/actions";
import { emptyFormState, type FormState } from "@/features/auth/schemas";
import { useSubmitWithoutReset } from "@/components/admin/unsaved-changes";
import type { ChildProfileRow } from "@/types/database";

/**
 * Child profile form — UI/UX §18.
 *
 * "The experience should feel family-oriented rather than like social-profile
 * management." Two fields, one optional, no avatar upload: Brief §46 keeps
 * children's identifying information out of the system, and §18 warns against
 * overemphasising profile identity.
 */
function ChildFields({
  child,
  state,
}: {
  child?: ChildProfileRow;
  state: FormState;
}) {
  return (
    <>
      <Field
        label="Name"
        htmlFor="displayName"
        hint="Enter one first name or nickname only. Do not include a surname."
        error={state.fieldErrors?.displayName}
      >
        <Input
          id="displayName"
          name="displayName"
          defaultValue={child?.display_name ?? ""}
          required
          maxLength={40}
          pattern="\s*\S+\s*"
          title="Enter one first name or nickname only."
          invalid={Boolean(state.fieldErrors?.displayName)}
        />
      </Field>

      <Field
        label="Year of birth"
        htmlFor="birthYear"
        hint="Optional. Used only to show which missions suit their age."
        error={state.fieldErrors?.birthYear}
      >
        <Input
          id="birthYear"
          name="birthYear"
          type="number"
          inputMode="numeric"
          defaultValue={child?.birth_year ?? ""}
          placeholder="2014"
          invalid={Boolean(state.fieldErrors?.birthYear)}
        />
      </Field>
    </>
  );
}

const linkClass =
  "inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-small)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]";

/** Editing an existing profile. Its access code is managed beside it. */
export function ChildForm({ child }: { child: ChildProfileRow }) {
  const [state, formAction, isPending] = useActionState(
    updateChildAction.bind(null, child.id),
    emptyFormState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-[var(--space-l)]">
      <FormError message={state.error} />
      <ChildFields child={child} state={state} />
      <div className="flex flex-wrap items-center gap-[var(--space-m)]">
        <Button
          type="submit"
          size="large"
          isLoading={isPending}
          loadingLabel="Saving…"
        >
          Save changes
        </Button>
        <Link href="/account/children" className={linkClass}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

/**
 * Adding a child, safe to retry (D-144): one key per attempt, made on first
 * submit and kept for any retry of it. Made here, not rendered into the form, so
 * server and client HTML can't disagree.
 */
function useCreateChild(onCreated?: (created: NonNullable<CreateChildState["created"]>) => void) {
  const key = useRef<string | null>(null);
  return useActionState<CreateChildState, FormData>(async (prev, formData) => {
    key.current ??= globalThis.crypto?.randomUUID?.() ?? null;
    if (key.current) formData.set("creationKey", key.current);
    const result = await createChildAction(prev, formData);
    if (result.created) onCreated?.(result.created);
    return result;
  }, emptyFormState);
}

function AccessCodeChoice() {
  return (
    <fieldset>
      <legend className="text-[length:var(--text-label)] font-medium">
        Access code
      </legend>
      <p className="wla-measure mt-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        A code lets your child enter the Academy and open their own missions
        on their own &mdash; never purchases, settings or another child.
      </p>
      <label className="mt-[var(--space-s)] flex min-h-[var(--target-min)] cursor-pointer items-center gap-[var(--space-s)]">
        <input
          type="checkbox"
          name="accessCode"
          defaultChecked
          className="h-5 w-5 shrink-0 accent-[var(--color-primary)]"
        />
        <span>Create an access code now</span>
      </label>
      <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        You&rsquo;ll see the code straight after adding the profile. You can
        view, replace or turn off a code from their profile at any time.
      </p>
    </fieldset>
  );
}

/**
 * Adding a child in the middle of buying or redeeming, without leaving (D-144).
 * The same fields, action and validation as the page below. It is an explicit
 * submit: nothing is created until the parent presses Add.
 */
export function InlineNewChildForm({
  onCreated,
  onCancel,
  focusOnOpen = true,
}: {
  onCreated: (created: NonNullable<CreateChildState["created"]>) => void;
  onCancel?: () => void;
  focusOnOpen?: boolean;
}) {
  const [state, formAction, isPending] = useCreateChild(onCreated);
  // A refused name shouldn't empty what was typed.
  const submit = useSubmitWithoutReset(formAction);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (focusOnOpen) ref.current?.querySelector<HTMLInputElement>("input[name=displayName]")?.focus();
  }, [focusOnOpen]);

  return (
    <form
      ref={ref}
      action={formAction}
      onSubmit={submit}
      className="flex flex-col gap-[var(--space-l)] rounded-[var(--radius-card)] border border-[var(--color-border)] p-[var(--space-m)]"
    >
      <FormError message={state.error} />
      <ChildFields state={state} />
      <AccessCodeChoice />
      <div className="flex flex-wrap items-center gap-[var(--space-m)]">
        <Button type="submit" isLoading={isPending} loadingLabel="Adding…">
          Add this child
        </Button>
        {onCancel && (
          <Button type="button" variant="text" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Adding a child — with their access code in the same step (D-108).
 *
 * The code used to be reachable only from the child's profile after creation
 * (Account → Manage → Edit → Create a code), which hid the one way a child
 * enters on their own. Here it is part of adding them: on by default, plainly
 * explained, and optional — a child without a code is a supported state.
 *
 * The code is generated on the server, by the same database function as the
 * profile's "Create a code", and shown in the confirmation.
 */
export function NewChildForm({ next }: { next?: string }) {
  const [state, formAction, isPending] = useCreateChild();
  const submit = useSubmitWithoutReset(formAction);

  if (state.created) {
    return <ChildCreated created={state.created} next={state.next} />;
  }

  return (
    <form action={formAction} onSubmit={submit} className="flex flex-col gap-[var(--space-l)]">
      {next && <input type="hidden" name="next" value={next} />}
      <FormError message={state.error} />
      <ChildFields state={state} />

      <div className="border-t border-[var(--color-border)] pt-[var(--space-l)]">
        <AccessCodeChoice />
      </div>

      <div className="flex flex-wrap items-center gap-[var(--space-m)]">
        <Button
          type="submit"
          size="large"
          isLoading={isPending}
          loadingLabel="Adding…"
        >
          Add profile
        </Button>
        <Link href={next ?? "/account/children"} className={linkClass}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

function ChildCreated({
  created,
  next,
}: {
  created: NonNullable<CreateChildState["created"]>;
  next?: string;
}) {
  const { childId, name, code, codeFailed, viewable, alreadyAdded } = created;

  return (
    <div className="flex flex-col gap-[var(--space-l)]">
      {/* role=status so the change of view is announced after submitting. */}
      <p role="status" className="text-[length:var(--text-h3)]">
        {name} has been added.
      </p>

      {code ? (
        <RevealedCode
          code={code}
          childName={name}
          intro={`${name}’s access code.`}
          viewable={viewable}
        />
      ) : codeFailed ? (
        <FormError
          message={`We couldn't make ${name}'s code just now. You can make one from their profile.`}
        />
      ) : alreadyAdded ? (
        <p className="wla-measure text-[var(--color-text-muted)]">
          You can view or create {name}&rsquo;s access code from their profile.
        </p>
      ) : (
        <p className="wla-measure text-[var(--color-text-muted)]">
          {name} doesn&rsquo;t have an access code yet. You can make one from
          their profile whenever you&rsquo;re ready.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-[var(--space-m)]">
        {/* Back into what they were doing — e.g. the mission they were buying. */}
        <ButtonLink href={next ?? "/account/children"} size="large">
          {next ? "Continue" : "Done"}
        </ButtonLink>
        <Link href={`/account/children/${childId}`} className={linkClass}>
          Manage {name}&rsquo;s profile
        </Link>
      </div>
    </div>
  );
}
