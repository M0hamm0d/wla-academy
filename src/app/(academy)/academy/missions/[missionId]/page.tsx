import Image from "next/image";
import Link from "next/link";
import { AcademyShell } from "@/components/academy/academy-shell";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { StartMissionButton } from "@/components/mission/start-mission-button";
import { ErrorState } from "@/components/system/states";
import { MissionIdentity } from "@/components/mission/mission-identity";
import { resolveMissionCover } from "@/features/missions/covers";
import { resolveAcademyActor } from "@/features/academy/actor";
import { getMissionHomeFor } from "@/features/academy/collection";
import { AccessError } from "@/lib/permissions";

/**
 * MISSION HOME — Architecture §5 (LOCKED), UI/UX §24–§28.
 *
 * The permanent home for one mission. Exists before, during and after
 * completion; never restarts the mission automatically (Architecture §17).
 *
 * LOCKED HIERARCHY (Architecture §5, UI/UX §25):
 *   1. mission identity
 *   2. Start / Continue Mission     ← the strongest action
 *   3. Mission Kit · For Parents    ← accessible but clearly subordinate
 *
 * The action label is derived from status, never from which route the child
 * arrived through.
 */
export default async function MissionHomePage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;

  const actor = await resolveAcademyActor();
  if (actor.kind !== "parent" && actor.kind !== "child") {
    return (
      <main className="wla-container py-[var(--space-2xl)]">
        <ErrorState
          as="h1"
          title="Choose a child first."
          body="Mission access belongs to a child profile."
        />
      </main>
    );
  }

  let home;
  try {
    home = await getMissionHomeFor(actor, missionId);
  } catch (error) {
    // Tech Spec §26: if entitlement fails, do NOT render the mission
    // experience. A 404 also avoids confirming that the mission exists.
    if (error instanceof AccessError) {
      if (error.reason === "not_entitled" || error.reason === "not_found") {
        notFound();
      }
    }
    return (
      <main className="wla-container py-[var(--space-2xl)]">
        <ErrorState
          as="h1"
          title="We couldn't load this mission."
          body="Your mission progress is safe. Please try again."
        />
      </main>
    );
  }

  // No row means not entitled, or no such mission. Tech Spec §26: do not
  // render the mission experience, and do not confirm the mission exists.
  // OUTSIDE the try: notFound() throws, and inside it the catch below turned
  // the 404 into "We couldn't load this mission. Please try again." — found
  // in staging QA with an unentitled child session.
  if (!home) notFound();

  const { mission, status } = home;
  const isChild = actor.kind === "child";
  const base = `/academy/missions/${mission.slug}`;

  // Architecture §6 — the three states of the primary action.
  // Start and Continue both mutate (they create or touch progress), so both go
  // through the server action. Complete is read-only and stays a link.
  const primaryLabel =
    status === "not_started" ? "Start Mission →" : "Continue Mission →";

  const cover = resolveMissionCover(mission);

  return (
    <AcademyShell>
      <main>
        <div className="wla-container wla-split py-[var(--space-xl)] md:py-[var(--space-2xl)]">
          {cover && (
            <div className="lg:col-span-5">
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[var(--radius-surface)] bg-[var(--color-surface-sage)]">
                <Image
                  src={cover.src}
                  alt={cover.alt}
                  fill
                  priority
                  sizes="(min-width: 1024px) 460px, 100vw"
                  className="object-cover"
                />
              </div>
            </div>
          )}

          <div className={cover ? "lg:col-span-7" : "lg:col-span-8"}>
            <MissionIdentity mission={mission} status={status} />

            {/* 2. The strongest action. Nothing below may compete with it. */}
            <div className="mt-[var(--space-xl)]">
              {status === "complete" ? (
                <ButtonLink href={`${base}/trail`} size="large">
                  View Mission Trail →
                </ButtonLink>
              ) : (
                <StartMissionButton
                  missionSlug={mission.slug}
                  label={primaryLabel}
                />
              )}

              {status === "in_progress" && (
                <p className="mt-[var(--space-sm)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                  You&rsquo;ll go back to where you stopped.
                </p>
              )}
              {status === "complete" && (
                <p className="mt-[var(--space-sm)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
                  You finished this one. It stays here, and so does everything
                  you made.
                </p>
              )}
            </div>
          </div>
        </div>

        {/*
          3. Subordinate. Available in every status, including Complete
          (Architecture §7, §8, §17).

          A FULL-BLEED SAGE BAND, not a rounded shelf. The public site marks a
          change of register by changing the page's background edge to edge —
          it never floats a tinted panel on the canvas. The band does the same
          job the shelf was doing, and does it in the site's own vocabulary:
          everything above is the child's mission and the one action that
          matters; everything inside is the support around it.

          Still not cards — Brief §34, "do not default to cards" — and Start
          stays unmistakably dominant (Architecture §5).
        */}
        <div className="wla-band-sage wla-section">
          <div className="wla-container wla-split">
            <section className="lg:col-span-6">
              <h2 className="text-[length:var(--text-h3)]">Mission Kit</h2>
              <p className="mt-[var(--space-xs)] text-[var(--color-text-muted)]">
                Everything you&rsquo;ll need for this mission.
              </p>
              <Link
                href={`${base}/kit`}
                className="mt-[var(--space-s)] inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] font-medium underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]"
              >
                Open Mission Kit →
              </Link>
            </section>

            {/*
              FOR PARENTS IS NOT SHOWN TO A CHILD.

              Architecture §8 makes this adult guidance — how to help, what to
              watch for, what the mission is really asking. It is not concealed
              mission content, but it is not addressed to the child either, and
              a child session has no reason to be handed the parent's note.
              The route itself refuses a child session as well; this only stops
              offering it.
            */}
            {!isChild && (
            <section className="lg:col-span-6">
              <h2 className="text-[length:var(--text-h3)]">For Parents</h2>
              <p className="mt-[var(--space-xs)] text-[var(--color-text-muted)]">
                A short note about helping your child get started.
                {/*
                  Say what opens. A link that turns out to be a PDF is a small
                  surprise for anyone, and a larger one for someone on a phone
                  or using a screen reader. Shown only where a document
                  actually exists, so a text-only note is never mislabelled.
                */}
                {home.hasParentNoteDocument && " Opens as a PDF."}
              </p>
              <Link
                href={`${base}/parents`}
                className="mt-[var(--space-s)] inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] font-medium underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]"
              >
                Read the parent note →
              </Link>
            </section>
            )}
          </div>
        </div>

      </main>
    </AcademyShell>
  );
}
