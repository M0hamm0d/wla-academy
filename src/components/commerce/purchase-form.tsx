"use client";

import { useActionState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { acquireMissionAction } from "@/features/commerce/actions";
import { emptyFormState } from "@/features/auth/schemas";
import { ChildPicker } from "./child-picker";
import { ConsentFields } from "./consent-fields";
import type { ChildProfileRow } from "@/types/database";

/**
 * Child selection before payment.
 *
 * Architecture §3: "Mission access must be associated with the intended child
 * profile before child-specific progress begins." The choice is made here,
 * explicitly, rather than inferred from whoever happens to be the active child
 * — a purchase is a deliberate act and deserves a deliberate choice. A new child
 * can be added here without leaving (D-144). The server still verifies whichever
 * child is submitted.
 */
export function PurchaseForm({
  missionSlug,
  missionTitle,
  /** Rendered label only. The server re-reads the real price when charging. */
  priceLabel,
  isFree,
  childProfiles,
  alreadyOwnedBy,
}: {
  missionSlug: string;
  missionTitle: string;
  priceLabel: string;
  isFree: boolean;
  childProfiles: ChildProfileRow[];
  alreadyOwnedBy: string[];
}) {
  const action = acquireMissionAction.bind(null, missionSlug);
  const [state, formAction, isPending] = useActionState(action, emptyFormState);

  return (
    <ChildPicker
      childProfiles={childProfiles}
      alreadyOwnedBy={alreadyOwnedBy}
      missionTitle={missionTitle}
      allOwnedAction={
        <ButtonLink href="/academy/my-missions" className="mt-[var(--space-m)] inline-block">
          Go to My Missions
        </ButtonLink>
      }
    >
      {(childId) => (
        <form action={formAction} className="flex flex-col gap-[var(--space-l)]">
          <FormError message={state.error} />
          <input type="hidden" name="childId" value={childId} />
          {!isFree && <ConsentFields error={state.fieldErrors?.consent} />}
      <Button
        type="submit"
        size="large"
        isLoading={isPending}
        loadingLabel={isFree ? "Adding mission…" : "Taking you to payment…"}
      >
        {isFree ? "Add this mission" : `Continue to payment — ${priceLabel}`}
      </Button>

      <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        {isFree
          ? "This mission is free. It'll appear in My Missions straight away."
          : "Payment is handled by Stripe. The mission appears in My Missions once the payment is confirmed."}
      </p>
        </form>
      )}
    </ChildPicker>
  );
}
