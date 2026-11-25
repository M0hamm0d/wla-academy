import Link from "next/link";
import { SignInForm } from "@/components/auth/sign-in-form";
import { ButtonLink } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/field";

export const metadata = { title: "Sign in" };

const LINK_ERRORS: Record<string, string> = {
  link_expired: "That link has expired. Request a new one below.",
  link_invalid: "That link didn't work. Request a new one below.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const isMyMissionsEntry =
    next?.split(/[?#]/, 1)[0] === "/academy/my-missions";

  return (
    <>
      <h1 className="text-[length:var(--text-h1)]">Sign in</h1>
      <p className="mt-[var(--space-s)] text-[var(--color-text-muted)]">
        {isMyMissionsEntry ? (
          "For parents and guardians."
        ) : (
          <>
            Parents and guardians sign in here.{" "}
            {/* The only way in for a child sent here from an Academy link. */}
            <Link
              href="/child/login"
              className="text-[var(--color-text)] underline decoration-[var(--color-border-strong)] underline-offset-4"
            >
              Have a child code?
            </Link>
          </>
        )}
      </p>

      {next?.startsWith("/purchase/") && (
        <div className="mt-[var(--space-l)]">
          <FormNotice message="Sign in or create an account to get this mission. We'll bring you straight back to it." />
        </div>
      )}

      <div className="mt-[var(--space-l)] flex flex-col gap-[var(--space-l)]">
        {error && <FormError message={LINK_ERRORS[error]} />}
        <SignInForm next={next} showCreateAccount={!isMyMissionsEntry} />
      </div>

      {isMyMissionsEntry && (
        <div className="mt-[var(--space-l)]">
          <div className="border-t border-[var(--color-border)] pt-[var(--space-l)]">
            <ButtonLink
              href="/child/login"
              variant="secondary"
              size="large"
              className="w-full"
            >
              Enter Child Access Code
            </ButtonLink>
          </div>

          <div className="mt-[var(--space-l)] border-t border-[var(--color-border)] pt-[var(--space-s)] text-center">
            <p className="text-[var(--color-text-muted)]">New to WLA?</p>
            <ButtonLink
              href="https://wla-xi.vercel.app/missions"
              variant="text"
              className="w-full justify-center"
            >
              Explore Missions
            </ButtonLink>
          </div>
        </div>
      )}
    </>
  );
}
