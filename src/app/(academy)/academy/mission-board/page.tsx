import Link from "next/link";
import { notFound } from "next/navigation";
import { AcademyShell } from "@/components/academy/academy-shell";
import { LabIcon } from "@/components/mission/lab-icon";
import { resolveAcademyActor } from "@/features/academy/actor";
import { getBoardFor } from "@/features/mission-board/board";
import { LAB_LABEL } from "@/features/missions/labs";
import { cn } from "@/lib/utils";
import type { WlaLab } from "@/types/database";

export const metadata = { title: "Mission Board" };

/**
 * MISSION BOARD — Architecture §16 as amended, Enhancement Plan §9, D-73.
 *
 * A window into wider WLA practice: selected, anonymised approaches that a
 * parent permitted and WLA moderated. Not a feed. There is no author, no
 * count, no like, no ranking and nothing to reply to — the data has no such
 * fields. Curated contrasting approaches come first; then the newest.
 *
 * Only missions the child has COMPLETED are shown (D-96): another child's
 * approach would otherwise give a mission's reveals away.
 *
 * This is the Academy-wide Mission Board, NOT the Six Names printable
 * worksheet of the same name (C8).
 */
export default async function MissionBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string; lab?: string }>;
}) {
  const actor = await resolveAcademyActor();
  if (actor.kind === "anonymous") notFound();
  const { mission, lab } = await searchParams;
  const items = actor.kind === "parent" || actor.kind === "child" ? await getBoardFor(actor) : [];

  const missions = [...new Map(items.map((i) => [i.mission_slug, i.mission_title])).entries()];
  const labs = [...new Set(items.map((i) => i.lab))] as WlaLab[];
  const shown = items.filter((i) => (!mission || i.mission_slug === mission) && (!lab || i.lab === lab));
  const byMission = [...new Map(shown.map((i) => [i.mission_slug, { title: i.mission_title, lab: i.lab, items: shown.filter((x) => x.mission_slug === i.mission_slug) }])).values()];

  const href = (m?: string, l?: string) => {
    const q = new URLSearchParams();
    if (m) q.set("mission", m);
    if (l) q.set("lab", l);
    const s = q.toString();
    return `/academy/mission-board${s ? `?${s}` : ""}`;
  };
  const chip = (on: boolean) =>
    cn(
      "inline-flex min-h-[var(--target-min)] items-center gap-[var(--space-xs)] rounded-[var(--radius-control)] border px-[var(--space-m)] text-[length:var(--text-label)]",
      on ? "border-[var(--color-primary)] bg-[var(--color-surface-sage)] font-medium" : "border-[var(--color-border)] bg-[var(--color-surface)]",
    );

  return (
    <AcademyShell>
      <main className="wla-container-narrow py-[var(--space-2xl)]">
        <h1 className="mt-[var(--space-m)] text-[length:var(--text-h1)]">Mission Board</h1>
        <p className="mt-[var(--space-s)] wla-measure text-[var(--color-text-muted)]">
          Different ways other explorers approached missions you have finished. Shared with a parent&rsquo;s
          permission, with names and details taken out, and chosen by WLA.
        </p>

        {actor.kind === "parent_needs_child" || actor.kind === "parent_no_children" ? (
          <p className="mt-[var(--space-xl)] wla-measure">Choose a child first — the Board shows missions they have finished.</p>
        ) : items.length === 0 ? (
          <p className="mt-[var(--space-xl)] wla-measure">
            When you finish a mission, you&rsquo;ll be able to see how others approached it here.
          </p>
        ) : (
          <>
            {(missions.length > 1 || labs.length > 1) && (
              <nav aria-label="Filter the Board" className="mt-[var(--space-xl)] flex flex-col gap-[var(--space-s)]">
                {missions.length > 1 && (
                  <div className="flex flex-wrap items-center gap-[var(--space-xs)]">
                    <span className="mr-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">Mission</span>
                    <Link href={href(undefined, lab)} aria-current={!mission ? "page" : undefined} className={chip(!mission)}>{!mission && <span aria-hidden>✓</span>}All</Link>
                    {missions.map(([slug, title]) => (
                      <Link key={slug} href={href(slug, lab)} aria-current={mission === slug ? "page" : undefined} className={chip(mission === slug)}>
                        {mission === slug && <span aria-hidden>✓</span>}{title}
                      </Link>
                    ))}
                  </div>
                )}
                {labs.length > 1 && (
                  <div className="flex flex-wrap items-center gap-[var(--space-xs)]">
                    <span className="mr-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">Lab</span>
                    <Link href={href(mission, undefined)} aria-current={!lab ? "page" : undefined} className={chip(!lab)}>{!lab && <span aria-hidden>✓</span>}All</Link>
                    {labs.map((l) => (
                      <Link key={l} href={href(mission, l)} aria-current={lab === l ? "page" : undefined} className={chip(lab === l)}>
                        {lab === l && <span aria-hidden>✓</span>}{LAB_LABEL[l]}
                      </Link>
                    ))}
                  </div>
                )}
              </nav>
            )}

            {byMission.length === 0 ? (
              <p className="mt-[var(--space-xl)] wla-measure">Nothing matches that filter.</p>
            ) : (
              byMission.map((m) => (
                <section key={m.title} aria-labelledby={`board-${m.title}`} className="mt-[var(--space-2xl)]">
                  <p className="flex items-center gap-[var(--space-xs)] text-[length:var(--text-label)] text-[var(--color-text-muted)]">
                    <LabIcon lab={m.lab} size={18} />{LAB_LABEL[m.lab]}
                  </p>
                  <h2 id={`board-${m.title}`} className="mt-[var(--space-xs)] text-[length:var(--text-h2)]">{m.title}</h2>
                  <ul className="mt-[var(--space-m)] border-t border-[var(--color-border)]">
                    {m.items.map((i, n) => (
                      <li key={n} className="border-b border-[var(--color-border)] py-[var(--space-l)]">
                        {i.curated && (
                          <p className="text-[length:var(--text-label)] font-medium text-[var(--color-text-muted)]">
                            {i.approach ? `One approach: ${i.approach}` : "One approach"}
                          </p>
                        )}
                        <p className="wla-measure mt-[var(--space-xs)] whitespace-pre-line">{i.text}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </>
        )}
      </main>
    </AcademyShell>
  );
}
