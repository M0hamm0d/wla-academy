import Link from "next/link";
import { getFamilyMissionCollections } from "@/features/missions/queries";
import { STATUS_LABEL } from "@/components/mission/mission-status";
import type { MissionStatus } from "@/types/database";
import { BoardPermissions } from "@/components/account/board-permissions";
import { familyContributions } from "@/features/mission-board/board";
import { ErrorState } from "@/components/system/states";
import { listChildren } from "@/features/children/queries";
import { requireParent } from "@/lib/permissions";
import { OpenChildMissions } from "@/components/account/open-child-missions";
import { logError } from "@/lib/observability/logger";
import { PurchasedGifts } from "@/components/commerce/purchased-gifts";
import { listPurchasedGifts, type PurchasedGift } from "@/features/gifts/purchaser";

export const metadata = { title: "Account" };

/**
 * Account overview. Not a parent dashboard (Brief §18) — it manages the
 * account and child profiles, and nothing else. Mission guidance lives in each
 * mission's For Parents, per Architecture §8.
 *
 * Enhancement Plan §1 adds two things here, on the account side: switching to
 * a child's missions, and the Family Mission Guide (D-75).
 */
export default async function AccountPage() {
  let email: string | undefined;
  let children: { id: string; display_name: string }[] = [];
  let board: Awaited<ReturnType<typeof familyContributions>> = [];
  let gifts: PurchasedGift[] = [];
  let perChild: {
    id: string;
    name: string;
    missions: { title: string; slug: string; status: MissionStatus }[];
    codeActive: boolean;
  }[] = [];

  try {
    const { user } = await requireParent();
    email = user.email;
    // Each child's missions and access code, for the whole family in three
    // reads (LOW-1) — scoped to this parent inside the queries.
    let family: Awaited<ReturnType<typeof getFamilyMissionCollections>>;
    [children, board, family, gifts] = await Promise.all([
      listChildren(),
      familyContributions(),
      getFamilyMissionCollections(),
      // Secondary: the account still loads if gifts can't be read.
      listPurchasedGifts().catch((error) => {
        logError("account_gifts_failed", error);
        return [] as PurchasedGift[];
      }),
    ]);
    perChild = family.map((c) => ({
      ...c,
      missions: c.missions.map((m) => ({
        title: m.mission.title,
        slug: m.mission.slug,
        status: m.status,
      })),
    }));
  } catch (error) {
    logError("account_page_failed", error);

    return (
      <main className="wla-container py-[var(--space-2xl)]">
        <ErrorState title="We couldn't load your account." />
      </main>
    );
  }

  return (
    <main className="wla-container py-[var(--space-2xl)]">
      <h1 className="text-[length:var(--text-h1)]">Account</h1>

      <dl className="mt-[var(--space-xl)] border-t border-[var(--color-border)]">
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-m)] border-b border-[var(--color-border)] py-[var(--space-l)]">
          <dt className="text-[length:var(--text-label)] text-[var(--color-text-muted)]">
            Email
          </dt>
          <dd>{email}</dd>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-m)] border-b border-[var(--color-border)] py-[var(--space-l)]">
          <dt className="text-[length:var(--text-label)] text-[var(--color-text-muted)]">
            Child profiles
          </dt>
          <dd className="flex items-center gap-[var(--space-l)]">
            <span>{children.length}</span>
            <Link
              href="/account/children"
              className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]"
            >
              Manage
            </Link>
            {/* Adding a child is also where their access code is made (D-108). */}
            <Link
              href="/account/children/new"
              className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]"
            >
              Add a child
            </Link>
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-m)] border-b border-[var(--color-border)] py-[var(--space-l)]">
          <dt className="text-[length:var(--text-label)] text-[var(--color-text-muted)]">
            Password
          </dt>
          <dd>
            <Link
              href="/forgot-password"
              className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]"
            >
              Change password
            </Link>
          </dd>
        </div>
      </dl>

      {/*
        Each child's missions — Plan §1: entitlements live in the account area.
        What a child HAS, with its status in words; opening them switches the
        Academy to that child (D-74). No purchase history or prices here.
      */}
      {perChild.length > 0 && (
        <section
          aria-labelledby="account-children"
          className="mt-[var(--space-2xl)]"
        >
          <h2 id="account-children" className="text-[length:var(--text-h3)]">
            Missions
          </h2>
          <ul className="mt-[var(--space-s)] flex flex-col gap-[var(--space-l)]">
            {perChild.map((c) => (
              <li key={c.id}>
                <h3 className="font-medium">{c.name}</h3>
                {c.missions.length === 0 ? (
                  <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                    No missions yet.
                  </p>
                ) : (
                  <ul className="mt-[var(--space-xs)] flex flex-col gap-[2px] text-[length:var(--text-small)]">
                    {c.missions.map((m) => (
                      <li key={m.slug}>
                        {m.title} — {STATUS_LABEL[m.status]}
                      </li>
                    ))}
                  </ul>
                )}
                <OpenChildMissions childId={c.id} name={c.name} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        Privacy and permissions — Plan §1 keeps them in the account area.
        States only what the Academy does (Architecture §3, §15, §16; D-58,
        D-73) and the approved retention policy (D-148).
      */}
      <section
        aria-labelledby="privacy-permissions"
        className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]"
      >
        <h2 id="privacy-permissions" className="text-[length:var(--text-h3)]">
          Privacy and permissions
        </h2>
        <ul className="wla-measure mt-[var(--space-s)] flex flex-col gap-[var(--space-s)]">
          <li>
            Each child&rsquo;s Mission Trail is private to them. Nothing in it
            is shared unless you give permission for the Mission Board.
          </li>
          <li>
            Child access codes let a child open only their own missions — never
            purchases, settings or another child.
            {perChild.length > 0 && (
              <ul className="mt-[var(--space-xs)] flex flex-col gap-[2px] text-[length:var(--text-small)]">
                {perChild.map((c) => (
                  <li key={c.id}>
                    {c.name}: {c.codeActive ? "a code is active" : "no code"} ·{" "}
                    <Link
                      href={`/account/children/${c.id}`}
                      className="inline-flex min-h-[var(--target-min)] items-center underline decoration-[var(--color-border-strong)] underline-offset-4"
                    >
                      Manage
                      <span className="sr-only">
                        {" "}
                        {c.name}&rsquo;s profile and code
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li>
            Deleting a child profile deletes their missions, progress, Mission
            Trail and its files. Other profiles aren&rsquo;t affected.
          </li>
          <li>
            Nothing is deleted because an account hasn&rsquo;t been used for a
            while: missions and saved work stay while the account is open.
          </li>
        </ul>
        {board.length > 0 ? (
          <BoardPermissions rows={board} nested />
        ) : (
          <p className="wla-measure mt-[var(--space-m)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
            Mission Board: nothing has been offered. If a child offers
            something, you&rsquo;ll decide here.
          </p>
        )}
      </section>

      {/* Gifts this parent bought: the codes to share (D-149). */}
      {gifts.length > 0 && (
        <section
          aria-labelledby="account-gifts"
          className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]"
        >
          <h2 id="account-gifts" className="text-[length:var(--text-h3)]">
            Gifts you&rsquo;ve bought
          </h2>
          <PurchasedGifts gifts={gifts} />
        </section>
      )}

      {/* Keeping saved work, and closing the account (D-148). */}
      <section
        aria-labelledby="account-data"
        className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]"
      >
        <h2 id="account-data" className="text-[length:var(--text-h3)]">
          Your data
        </h2>
        <div className="mt-[var(--space-s)] flex flex-wrap gap-[var(--space-l)]">
          <a
            href="/account/saved-work"
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            Download saved work
          </a>
          <Link
            href="/account/close"
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            Close your account
          </Link>
        </div>
      </section>

      {/* Help and support — the approved support copy (Website Master §10). */}
      <section
        aria-labelledby="account-support"
        className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]"
      >
        <h2 id="account-support" className="text-[length:var(--text-h3)]">
          Need help?
        </h2>
        <p className="wla-measure mt-[var(--space-xs)]">
          Already have a mission? Find it in My Missions.
        </p>
        <div className="mt-[var(--space-s)] flex flex-wrap gap-[var(--space-l)]">
          <Link
            href="/academy/my-missions"
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            Go to My Missions →
          </Link>
          <Link
            href="/academy/help"
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            Academy help →
          </Link>
          <Link
            href="/academy/my-missions"
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            Explore Missions →
          </Link>
        </div>
      </section>

      {/*
        Family Mission Guide — account side (Enhancement Plan §1, Architecture
        §3 as amended). Its approved text is a WLA authority document that is
        not in the repository yet (OPEN-15), so this states what the guide is
        and does not invent its content (D-75).
      */}
      <section
        aria-labelledby="family-guide"
        className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]"
      >
        <h2 id="family-guide" className="text-[length:var(--text-h3)]">
          Family Mission Guide
        </h2>
        <p className="wla-measure mt-[var(--space-xs)] text-[var(--color-text-muted)]">
          How WLA missions work at home: choosing a child, My Missions, the
          Mission Kit and Mission Trail. The guide will be available here soon.
        </p>
      </section>
    </main>
  );
}
