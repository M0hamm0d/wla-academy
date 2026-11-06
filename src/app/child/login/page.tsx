import { redirect } from "next/navigation";
import Link from "next/link";
import { ChildLoginForm } from "@/components/child/child-login-form";
import { getChildSession } from "@/lib/child-session";

export const metadata = { title: "Enter the Academy" };

/**
 * CHILD SIGN-IN — brief §6.
 *
 * The child's code is the primary task; parents can follow the discreet link
 * below the form to their own sign-in page.
 */
export default async function ChildLoginPage() {
  // Already signed in: don't show a sign-in form to someone who is.
  // On the sign-in page an unreachable check just means "show the form" (D-98).
  const existing = await getChildSession().catch(() => null);
  if (existing) redirect("/academy/my-missions");

  return (
    <main className="wla-container">
      <div className="mx-auto w-full max-w-[26rem] py-[var(--space-2xl)]">
        <p className="font-[family-name:var(--font-serif)] text-[length:var(--text-h3)]">
          WLA Academy
        </p>
        <h1 className="mt-[var(--space-l)] text-[length:var(--text-h1)]">
          Enter your child code
        </h1>
        <p className="mt-[var(--space-s)] wla-measure text-[var(--color-text-muted)]">
          Your code lets you open your own missions.
        </p>

        <div className="mt-[var(--space-xl)]">
          <ChildLoginForm />
        </div>
        <p className="mt-[var(--space-l)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
          Parent or guardian?{" "}
          <Link
            href="/login"
            className="inline-flex min-h-[var(--target-min)] items-center text-[var(--color-text-action)] underline decoration-[var(--color-border-strong)] underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
