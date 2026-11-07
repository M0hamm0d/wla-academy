"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { emptyFormState } from "@/features/auth/schemas";
import { closeAccountAction } from "@/features/privacy/actions";

/**
 * The last step of closing an account (D-148): the parent confirms they
 * understand, and enters their password again. The server checks both; the
 * page's `required` is only a help.
 */
export function CloseAccountForm() {
  const [state, action, isPending] = useActionState(closeAccountAction, emptyFormState);
  return (
    <form action={action} className="flex flex-col gap-[var(--space-l)]">
      <FormError message={state.error} />
      <div className="flex flex-col gap-[var(--space-xs)]">
        <label className="flex min-h-[var(--target-min)] items-start gap-[var(--space-s)]">
          <input
            type="checkbox"
            name="understood"
            value="yes"
            required
            aria-describedby={state.fieldErrors?.understood ? "understood-error" : undefined}
            className="mt-[3px] h-5 w-5 shrink-0 accent-[var(--color-primary)]"
          />
          <span>
            I understand that my account, every child profile on it and all their saved work will be
            deleted, and that this can&rsquo;t be undone.
          </span>
        </label>
        {state.fieldErrors?.understood && (
          <p id="understood-error" className="text-[length:var(--text-small)] text-[var(--color-error)]">
            {state.fieldErrors.understood}
          </p>
        )}
      </div>
      <Field label="Your password" htmlFor="password" error={state.fieldErrors?.password} hint="To confirm it's you.">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>
      <Button
        type="submit"
        size="large"
        isLoading={isPending}
        loadingLabel="Closing your account…"
        className="bg-[var(--color-error)] hover:bg-[var(--color-error)]"
      >
        Close my account
      </Button>
    </form>
  );
}
