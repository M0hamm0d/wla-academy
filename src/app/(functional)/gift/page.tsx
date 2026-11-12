import { ArrowLink } from "@/components/public-site/public-site";
import { PurchasedGifts } from "@/components/commerce/purchased-gifts";
import { FormNotice } from "@/components/ui/field";
import { listPurchasedGifts, type PurchasedGift } from "@/features/gifts/purchaser";
import { AccessError } from "@/lib/permissions";
import { PUBLIC_MISSIONS } from "@/features/public-site/catalogue";
import { getPublicMissionFacts } from "@/features/public-site/queries";

export const metadata = { title: "Buy a Gift" };

/**
 * BUY A GIFT (D-140, D-149). Choosing what to give; everything else happens on
 * the ordinary purchase page, with its gift toggle already on. There is no
 * second checkout here. Back from Stripe, the purchaser sees their gift code
 * here, to share with the recipient themselves.
 */
export default async function GiftPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string }>;
}) {
  const { purchase } = await searchParams;
  let bought: PurchasedGift[] = [];
  if (purchase === "success") {
    try {
      bought = await listPurchasedGifts();
    } catch (error) {
      // Signed out on the way back: the code is in their email and their account.
      if (!(error instanceof AccessError)) throw error;
    }
  }
  const facts = await Promise.all(
    PUBLIC_MISSIONS.map(async (m) => ({ mission: m, facts: await getPublicMissionFacts(m.slug) })),
  );
  // A priced, published mission: a free one needs no gift, and an unpublished one can't be bought.
  const giftable = facts.filter((f) => f.facts?.priceLabel);

  return (
    <main className="wla-container">
      <div className="mx-auto w-full max-w-[34rem] py-[var(--space-2xl)]">
        <h1 className="text-[length:var(--text-h1)]">Buy a Gift</h1>
        {purchase === "success" ? (
          <div className="mt-[var(--space-l)]">
            <FormNotice message="Thank you. Once your payment is confirmed, your gift code appears here and in your confirmation email. Share it with the person you're giving it to." />
            <PurchasedGifts gifts={bought} />
          </div>
        ) : (
          <p className="wla-measure mt-[var(--space-m)] text-[var(--color-text-muted)]">
            Choose a mission to give. After paying you&rsquo;ll get a gift code to share with the
            person you&rsquo;re giving it to, however you like. We don&rsquo;t need their email address.
          </p>
        )}
        {giftable.length === 0 ? (
          <p className="mt-[var(--space-xl)] text-[var(--color-text-muted)]">
            No missions are available to give right now.
          </p>
        ) : (
          <ul className="mt-[var(--space-xl)] flex flex-col gap-[var(--space-m)]">
            {giftable.map(({ mission, facts: f }) => (
              <li key={mission.slug}>
                <ArrowLink href={`/purchase/${mission.slug}?gift=1`}>
                  {mission.title} — {f?.priceLabel}
                </ArrowLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
