import Link from "next/link";
import { EmptyState } from "@/components/system/states";
import { ButtonLink } from "@/components/ui/button";
import { getFreeMissions } from "@/features/commerce/queries";
import { LAB_LABEL } from "@/features/missions/labs";
import { formatMissionMeta } from "@/lib/utils";

export const metadata = { title: "Try a free mission" };

/**
 * TRY A FREE MISSION — Architecture §1 (locked functional route), Brief §49.
 *
 * Free access uses the same Academy architecture as everything else: the same
 * purchase route, the same child selection, the same entitlement table. Only
 * the `source` differs (D-10).
 *
 * Which missions are free comes from `is_free` on the mission row — no mission
 * is named here, and none is invented (OPEN-03).
 */
export default async function TryFreePage() {
  let missions;
  try {
    missions = await getFreeMissions();
  } catch {
    // Signed out: the route is public, so invite them in rather than erroring.
    return (
      <main className="wla-container py-[var(--space-4xl)]">
        <Intro />
        <div className="mt-[var(--space-xl)] flex flex-wrap items-center gap-[var(--space-l)]">
          <ButtonLink href="/signup" size="large">
            Create an account →
          </ButtonLink>
          <Link
            href="/login"
            className="inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-small)] font-medium underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]"
          >
            Sign in →
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="wla-container py-[var(--space-4xl)]">
      <Intro />

      {missions.length === 0 ? (
        <EmptyState
          title="No free mission right now"
          body="Have a look at the full collection instead."
          action={{
            label: "Explore Missions →",
            href: "/academy/my-missions",
          }}
        />
      ) : (
        <ul className="mt-[var(--space-xl)] border-t border-[var(--color-border)]">
          {missions.map((mission) => (
            <li
              key={mission.id}
              className="flex flex-wrap items-center justify-between gap-[var(--space-m)] border-b border-[var(--color-border)] py-[var(--space-l)]"
            >
              <div>
                <h2 className="text-[length:var(--text-h3)]">
                  {mission.title}
                </h2>
                <p className="mt-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                  {LAB_LABEL[mission.lab]} ·{" "}
                  {formatMissionMeta(
                    mission.min_age,
                    mission.max_age,
                    mission.duration,
                  )}
                </p>
              </div>
              {/* Same route as a paid mission — the server decides which path */}
              <ButtonLink href={`/purchase/${mission.slug}`}>
                Get it free
              </ButtonLink>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Intro() {
  return (
    <>
      <h1 className="text-[length:var(--text-h1)]">Try a free mission</h1>
      <p className="wla-measure mt-[var(--space-m)] text-[var(--color-text-muted)]">
        Missions belong to a child, so you&rsquo;ll need an account and a child
        profile first.
      </p>
    </>
  );
}
