"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, FormError, FormNotice, Input } from "@/components/ui/field";
import { PasswordInput } from "@/components/auth/password-input";
import { signUpAction } from "@/features/auth/actions";
import { emptyFormState } from "@/features/auth/schemas";

/**
 * The account being created belongs to the parent/guardian (Architecture §3).
 * The copy says so, so nobody creates an account "for" a child.
 *
 * `next` is where they were heading — e.g. the mission they chose to buy — and
 * is carried through so creating an account does not lose it. The server
 * re-validates it (lib/safe-next); this only passes it along.
 */
export function SignUpForm({ next }: { next?: string }) {
  const [state, formAction, isPending] = useActionState(
    signUpAction,
    emptyFormState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-[var(--space-l)]">
      {next && <input type="hidden" name="next" value={next} />}
      <FormError message={state.error} />
      <FormNotice message={state.notice} />

      <Field
        label="Your name"
        htmlFor="name"
        hint="Optional."
        error={state.fieldErrors?.name}
      >
        <Input id="name" name="name" autoComplete="name" />
      </Field>

      <Field label="Email" htmlFor="email" error={state.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          invalid={Boolean(state.fieldErrors?.email)}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        hint="At least 8 characters."
        error={state.fieldErrors?.password}
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          required
          invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <Button
        type="submit"
        size="large"
        isLoading={isPending}
        loadingLabel="Creating account…"
      >
        Create account
      </Button>

      <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        Already have an account?{" "}
        <Link
          href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          className="text-[var(--color-text)] underline decoration-[var(--color-border-strong)] underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
