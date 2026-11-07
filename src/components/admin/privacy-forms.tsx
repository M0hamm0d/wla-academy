"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, FormNotice, Input } from "@/components/ui/field";
import { emptyFormState } from "@/features/auth/schemas";
import { adminCloseAccountAction, adminPlaceHoldAction } from "@/features/privacy/actions";

const select =
  "min-h-[var(--target-min)] w-full rounded-[var(--radius-input)] border border-[var(--color-border)] bg-[var(--color-surface)] px-[var(--space-s)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]";

/** Close an account for an erasure request WLA has verified (D-148). */
export function AdminCloseAccountForm() {
  const [state, action, isPending] = useActionState(adminCloseAccountAction, emptyFormState);
  return (
    <form action={action} className="flex max-w-[30rem] flex-col gap-[var(--space-m)]">
      <FormError message={state.error} />
      <FormNotice message={state.notice} />
      <Field label="Account email" htmlFor="close-email">
        <Input id="close-email" name="email" type="email" autoComplete="off" required />
      </Field>
      <Field label="Account email again" htmlFor="close-email-again">
        <Input id="close-email-again" name="emailAgain" type="email" autoComplete="off" required />
      </Field>
      <label className="flex min-h-[var(--target-min)] items-start gap-[var(--space-s)]">
        <input type="checkbox" name="verified" value="yes" required className="mt-[3px] h-5 w-5 accent-[var(--color-primary)]" />
        <span>The request has been verified as coming from this account holder.</span>
      </label>
      <Button type="submit" isLoading={isPending} loadingLabel="Closing…" className="self-start">
        Close this account
      </Button>
    </form>
  );
}

/** A documented exception to deletion or to log pruning. */
export function PlaceHoldForm() {
  const [state, action, isPending] = useActionState(adminPlaceHoldAction, emptyFormState);
  return (
    <form action={action} className="flex max-w-[30rem] flex-col gap-[var(--space-m)]">
      <FormError message={state.error} />
      <FormNotice message={state.notice} />
      <Field label="What it covers" htmlFor="hold-type">
        <select id="hold-type" name="subjectType" className={select} defaultValue="parent_account">
          <option value="parent_account">A parent account and its children</option>
          <option value="child_profile">One child profile</option>
          <option value="board_contribution">One Mission Board contribution</option>
          <option value="security_logs">Routine security logs (pauses 90-day pruning)</option>
        </select>
      </Field>
      <Field label="Id (not needed for security logs)" htmlFor="hold-id">
        <Input id="hold-id" name="subjectId" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Reason" htmlFor="hold-reason" hint="The lawful basis or the investigation. No child's details.">
        <Input id="hold-reason" name="reason" required maxLength={500} />
      </Field>
      <Field label="Review by" htmlFor="hold-review" hint="Within a year. Defaults to a year from today.">
        <Input id="hold-review" name="reviewBy" type="date" />
      </Field>
      <Button type="submit" isLoading={isPending} loadingLabel="Placing…" className="self-start">
        Place hold
      </Button>
    </form>
  );
}
