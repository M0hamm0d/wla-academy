import { cookies } from "next/headers";
import { ButtonLink } from "@/components/ui/button";
import { RedeemGiftForm, RedeemWithCodeForm } from "@/components/commerce/redeem-forms";
import { listChildren } from "@/features/children/queries";
import { getEntitledChildIds } from "@/features/commerce/queries";
import { GIFT_CLAIM_COOKIE, GIFT_REDEEM_PATH } from "@/features/gifts/claim";
import { readClaimedGift } from "@/features/gifts/redeem";
import { createClient } from "@/lib/supabase/server";

// Nothing secret is in this page's address, but it stays out of search results
// and sends no Referer, as it always has.
export const metadata = {
  title: "Redeem a Gift",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * REDEEM A GIFT (D-149). The one redemption page linked by the public site.
 *
 *   1. Enter the code the purchaser shared. Nothing is shown until it matches.
 *   2. Sign in or create an account: the same account flow as buying.
 *   3. Choose or add the child. The gift then becomes that child's entitlement.
 *
 * No email address is asked for or needed to find, deliver or check a gift. An
 * old emailed link (?token=) no longer means anything and lands on step 1.
 */
export default async function RedeemPage() {
  const claim = (await cookies()).get(GIFT_CLAIM_COOKIE)?.value;
  const gift = await readClaimedGift(claim);

  return (
    <main className="wla-container">
      <div className="mx-auto w-full max-w-[34rem] py-[var(--space-2xl)]">
        {gift ? (
          <Claim missionId={gift.missionId} missionTitle={gift.missionTitle} />
        ) : (
          <>
            <h1 className="text-[length:var(--text-h1)]">Redeem a gift.</h1>
            <p className="wla-measure mt-[var(--space-m)] text-[var(--color-text-muted)]">
              Enter the gift code you were given. Then you&rsquo;ll sign in or create an account, and
              choose the child the mission is for.
            </p>
            <div className="mt-[var(--space-xl)]">
              <RedeemWithCodeForm />
            </div>
          </>
        )}
      </div>
    </main>
  );
}

async function Claim({ missionId, missionTitle }: { missionId: string; missionTitle: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const here = encodeURIComponent(GIFT_REDEEM_PATH);

  return (
    <>
      <h1 className="text-[length:var(--text-h1)]">You&rsquo;ve been given {missionTitle}.</h1>
      {user ? (
        <div className="mt-[var(--space-xl)]">
          <RedeemGiftForm
            missionTitle={missionTitle}
            childProfiles={await listChildren()}
            alreadyOwnedBy={await getEntitledChildIds(missionId)}
          />
        </div>
      ) : (
        <>
          <p className="wla-measure mt-[var(--space-m)] text-[var(--color-text-muted)]">
            Missions belong to a child on a parent or guardian&rsquo;s account. Sign in or create an
            account, then choose who this mission is for.
          </p>
          <div className="mt-[var(--space-xl)] flex flex-wrap gap-[var(--space-m)]">
            <ButtonLink href={`/signup?next=${here}`}>Create an account</ButtonLink>
            <ButtonLink href={`/login?next=${here}`} variant="secondary">
              Sign in
            </ButtonLink>
          </div>
        </>
      )}
    </>
  );
}
