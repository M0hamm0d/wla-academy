import {
  CANCELLATION_ACKNOWLEDGEMENT,
  EARLY_SUPPLY_CONSENT,
} from "@/features/commerce/consent";

/**
 * The two statements a paid mission or gift needs before Stripe (D-152). Two
 * boxes, never pre-ticked, because each is a separate thing the customer
 * agrees to. `required` is only the browser's help: the server refuses an order
 * without both.
 */
export function ConsentFields({ error }: { error?: string }) {
  const terms = process.env.NEXT_PUBLIC_TERMS_URL;
  return (
    <fieldset
      className="flex flex-col gap-[var(--space-s)]"
      aria-describedby={error ? "consent-error" : undefined}
    >
      <legend className="text-[length:var(--text-label)] font-medium">Before you pay</legend>
      <label className="flex min-h-[var(--target-min)] items-start gap-[var(--space-s)]">
        <input
          type="checkbox"
          name="earlySupplyConsent"
          value="yes"
          required
          className="mt-[3px] h-5 w-5 shrink-0 accent-[var(--color-primary)]"
        />
        <span>{EARLY_SUPPLY_CONSENT}</span>
      </label>
      <label className="flex min-h-[var(--target-min)] items-start gap-[var(--space-s)]">
        <input
          type="checkbox"
          name="cancellationAcknowledged"
          value="yes"
          required
          className="mt-[3px] h-5 w-5 shrink-0 accent-[var(--color-primary)]"
        />
        <span>{CANCELLATION_ACKNOWLEDGEMENT}</span>
      </label>
      {error && (
        <p id="consent-error" className="text-[length:var(--text-small)] text-[var(--color-error)]">
          {error}
        </p>
      )}
      <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        We&rsquo;ll email you a confirmation of your order that includes both statements.
        {terms && (
          <>
            {" "}
            See our{" "}
            <a href={terms} className="underline underline-offset-4">
              Terms &amp; Conditions
            </a>
            .
          </>
        )}
      </p>
    </fieldset>
  );
}
