"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { emptyFormState } from "@/features/auth/schemas";
import { confirmGiftCodeAction, redeemGiftAction } from "@/features/gifts/actions";
import { ChildPicker } from "./child-picker";

/**
 * Redeem a Gift (D-149): the code the purchaser shared, and nothing else. No
 * email address is asked for. The code stays in this component only, never in
 * the URL or browser storage.
 */
export function RedeemWithCodeForm() {
  const [state, action, isPending] = useActionState(confirmGiftCodeAction, emptyFormState);
  // Controlled: React clears an uncontrolled field after every form action, and
  // someone told the code isn't right should see what they typed.
  const [code, setCode] = useState("");

  return (
    <form action={action} noValidate className="flex flex-col gap-[var(--space-l)]">
      <FormError message={state.error} />
      <Field
        label="Gift code"
        htmlFor="code"
        error={state.fieldErrors?.code}
        hint="Twelve letters and numbers, from the person who gave you the gift."
      >
        <Input
          id="code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          maxLength={20}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          invalid={Boolean(state.fieldErrors?.code)}
        />
      </Field>
      <Button type="submit" size="large" isLoading={isPending} loadingLabel="Checking…">
        Continue
      </Button>
    </form>
  );
}

/** Whose mission it becomes. Same shape as choosing a child when buying. */
export function RedeemGiftForm({
  missionTitle,
  childProfiles,
  alreadyOwnedBy,
}: {
  missionTitle: string;
  childProfiles: { id: string; display_name: string }[];
  alreadyOwnedBy: string[];
}) {
  const [state, action, isPending] = useActionState(redeemGiftAction, emptyFormState);
  return (
    <ChildPicker
      childProfiles={childProfiles}
      alreadyOwnedBy={alreadyOwnedBy}
      missionTitle={missionTitle}
      allOwnedNote="The gift hasn’t been used: add another child to redeem it."
    >
      {(childId) => (
        <form action={action} className="flex flex-col gap-[var(--space-l)]">
          <FormError message={state.error} />
          <input type="hidden" name="childId" value={childId} />
          <Button type="submit" size="large" isLoading={isPending} loadingLabel="Redeeming…">
            Redeem this gift
          </Button>
        </form>
      )}
    </ChildPicker>
  );
}
