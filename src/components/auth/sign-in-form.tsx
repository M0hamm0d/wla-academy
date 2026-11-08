"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { PasswordInput } from "@/components/auth/password-input";
import { signInAction } from "@/features/auth/actions";
import { emptyFormState } from "@/features/auth/schemas";

export function SignInForm({ next }: { next?: string }) {
  const [state, formAction, isPending] = useActionState(
    signInAction,
    emptyFormState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-[var(--space-l)]">
      {next && <input type="hidden" name="next" value={next} />}
      <FormError message={state.error} />

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
        error={state.fieldErrors?.password}
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          required
          invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <Button
        type="submit"
        size="large"
        isLoading={isPending}
        loadingLabel="Signing in…"
      >
        Sign in
      </Button>

      <div className="flex flex-col gap-[var(--space-s)] text-[length:var(--text-small)]">
        <Link
          href="/forgot-password"
          className="underline decoration-[var(--color-border-strong)] underline-offset-4"
        >
          Forgotten your password?
        </Link>
        <p className="text-[var(--color-text-muted)]">
          No account yet?{" "}
          <Link
            href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
            className="text-[var(--color-text)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            Create one
          </Link>
        </p>
      </div>
    </form>
  );
}
