import { ButtonLink } from "@/components/ui/button";
import { ForgetMissionDrafts } from "@/components/account/forget-mission-drafts";

export const metadata = { title: "Account closed", robots: { index: false, follow: false } };

/**
 * After closing an account (D-148). The browser is already signed out; this
 * also forgets any half-typed mission answers this tab still holds.
 */
export default async function AccountClosedPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  return (
    <main className="wla-container">
      <ForgetMissionDrafts />
      <div className="mx-auto w-full max-w-[34rem] py-[var(--space-2xl)]">
        <h1 className="text-[length:var(--text-h1)]">Your account is closed.</h1>
        <p className="wla-measure mt-[var(--space-m)] text-[var(--color-text-muted)]">
          {state === "done"
            ? "Your account, your children's profiles and their saved work have been deleted."
            : state === "held"
              ? "Your account no longer works. WLA has to keep its records for now for a legal reason, and will delete them when that ends."
              : "Your account no longer works. We're finishing deleting your children's profiles and saved work, and will be done within 30 days."}{" "}
          We keep only the payment records the law requires, without your name or your children&rsquo;s.
        </p>
        <div className="mt-[var(--space-xl)]">
          <ButtonLink href="/" variant="secondary">
            Back to the home page
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
