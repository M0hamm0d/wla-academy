import Link from "next/link";
import { CloseAccountForm } from "@/components/account/close-account-form";
import { ErrorState } from "@/components/system/states";
import { ButtonLink } from "@/components/ui/button";
import { listChildren } from "@/features/children/queries";

export const metadata = { title: "Close your account" };

/**
 * CLOSE YOUR ACCOUNT (D-148). What goes, what WLA has to keep, the chance to
 * keep the family's saved work first, then the confirmation. Plain words: this
 * is the family's data, and they should know exactly what happens to it.
 */
export default async function CloseAccountPage() {
  let children: { id: string; display_name: string }[];
  try {
    children = await listChildren();
  } catch {
    return (
      <main className="wla-container py-[var(--space-2xl)]">
        <ErrorState title="We couldn't load your account." />
      </main>
    );
  }

  return (
    <main className="wla-container">
      <div className="mx-auto w-full max-w-[36rem] py-[var(--space-2xl)]">
        <Link
          href="/account"
          className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4"
        >
          ← Back to Account
        </Link>
        <h1 className="mt-[var(--space-m)] text-[length:var(--text-h1)]">Close your account</h1>

        <section aria-labelledby="keep" className="mt-[var(--space-xl)]">
          <h2 id="keep" className="text-[length:var(--text-h3)]">First, keep your saved work</h2>
          <p className="wla-measure mt-[var(--space-s)] text-[var(--color-text-muted)]">
            Download a copy of {children.length === 1 ? `${children[0].display_name}’s` : "your children’s"} missions,
            Mission Trail and saved answers. It&rsquo;s a single file you can open, print or keep, and it
            isn&rsquo;t affected by closing the account.
          </p>
          <div className="mt-[var(--space-m)]">
            <ButtonLink href="/account/saved-work" variant="secondary">
              Download saved work
            </ButtonLink>
          </div>
        </section>

        <section aria-labelledby="what" className="mt-[var(--space-2xl)]">
          <h2 id="what" className="text-[length:var(--text-h3)]">What closing deletes</h2>
          <ul className="wla-measure mt-[var(--space-s)] list-disc pl-[var(--space-l)]">
            <li>Your account and sign-in.</li>
            <li>
              {children.length === 0
                ? "Any child profiles."
                : `${children.length === 1 ? "The child profile" : `All ${children.length} child profiles`}: ${children.map((c) => c.display_name).join(", ")}.`}
            </li>
            <li>Their missions, progress, saved answers, Mission Trails and any files in them.</li>
            <li>Anything they shared on the Mission Board, and their access codes.</li>
          </ul>
          <p className="wla-measure mt-[var(--space-m)] text-[var(--color-text-muted)]">
            We aim to finish within 30 days, and usually it&rsquo;s at once. Your account stops working
            straight away.
          </p>
        </section>

        <section aria-labelledby="kept" className="mt-[var(--space-2xl)]">
          <h2 id="kept" className="text-[length:var(--text-h3)]">What we have to keep</h2>
          <ul className="wla-measure mt-[var(--space-s)] list-disc pl-[var(--space-l)]">
            <li>
              A record of each payment (the amount, the date and the mission), without your name, your
              email or your children, because the law requires financial records to be kept. Stripe, our
              payment provider, keeps its own record of the payment.
            </li>
            <li>
              Gifts you bought that haven&rsquo;t been redeemed yet still work for whoever has the code.
              Copy any codes you still need before closing.
            </li>
            <li>
              Our backups are replaced on a rolling basis. Until an older backup is replaced it may still
              hold your data; it is never used to bring deleted accounts back.
            </li>
          </ul>
        </section>

        <section aria-labelledby="confirm" className="mt-[var(--space-2xl)]">
          <h2 id="confirm" className="text-[length:var(--text-h3)]">Close the account</h2>
          <div className="mt-[var(--space-m)]">
            <CloseAccountForm />
          </div>
        </section>
      </div>
    </main>
  );
}
