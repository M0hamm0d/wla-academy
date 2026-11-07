"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { emptyFormState } from "@/features/auth/schemas";
import { giftMissionAction } from "@/features/gifts/actions";
import { ConsentFields } from "./consent-fields";
import { PurchaseForm } from "./purchase-form";

type PanelProps = React.ComponentProps<typeof PurchaseForm> & { startAsGift: boolean };

/**
 * The purchase page's two ways to buy: for a child on this account (unchanged,
 * and the default), or as a gift (D-140). Free missions aren't offered as gifts:
 * anyone can already add one.
 */
export function PurchasePanel({ startAsGift, ...purchase }: PanelProps) {
  const giftable = !purchase.isFree;
  const [asGift, setAsGift] = useState(giftable && startAsGift);
  const toggleId = useId();

  return (
    <div className="flex flex-col gap-[var(--space-l)]">
      {giftable && (
        <label
          htmlFor={toggleId}
          className="flex min-h-[var(--target-min)] cursor-pointer items-center justify-between gap-[var(--space-m)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-[var(--space-m)] py-[var(--space-sm)]"
        >
          <span className="font-medium">Give as a gift?</span>
          <span className="flex items-center gap-[var(--space-s)]">
            {/* In words as well: on and off must not rest on colour alone. */}
            <span className="text-[length:var(--text-small)] text-[var(--color-text-muted)]" aria-hidden>
              {asGift ? "On" : "Off"}
            </span>
            <span className="relative inline-flex h-7 w-12 shrink-0">
              <input
                id={toggleId}
                type="checkbox"
                role="switch"
                checked={asGift}
                onChange={(e) => setAsGift(e.target.checked)}
                className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-full border border-[var(--color-border-strong)] bg-[var(--color-background)] checked:border-[var(--color-primary)] checked:bg-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-[var(--color-text-muted)] transition-transform peer-checked:translate-x-5 peer-checked:bg-[var(--color-background)] motion-reduce:transition-none"
              />
            </span>
          </span>
        </label>
      )}

      {asGift && <GiftForm missionSlug={purchase.missionSlug} priceLabel={purchase.priceLabel} />}
      {/* Kept mounted: a child just added, and their code, survive the toggle. */}
      <div hidden={asGift}>
        <PurchaseForm {...purchase} />
      </div>
    </div>
  );
}

function GiftForm({ missionSlug, priceLabel }: { missionSlug: string; priceLabel: string }) {
  const action = giftMissionAction.bind(null, missionSlug);
  const [state, formAction, isPending] = useActionState(action, emptyFormState);

  return (
    <form action={formAction} className="flex flex-col gap-[var(--space-l)]">
      <FormError message={state.error} />
      <p className="text-[var(--color-text-muted)]">
        Once your payment is confirmed you&rsquo;ll get a gift code, on screen and by email. Share it
        with the person you&rsquo;re giving it to, however you like: they enter it on Redeem a Gift and
        choose their child. We don&rsquo;t need their email address.
      </p>
      <ConsentFields error={state.fieldErrors?.consent} />
      <Button type="submit" size="large" isLoading={isPending} loadingLabel="Taking you to payment…">
        {`Continue to payment — ${priceLabel}`}
      </Button>
      <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        Payment is handled by Stripe. A gift isn&rsquo;t added to your account: it goes to whoever
        redeems the code.
      </p>
    </form>
  );
}
