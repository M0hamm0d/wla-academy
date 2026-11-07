import { permitBoardAction, withdrawBoardAction } from "@/features/mission-board/actions";
import type { BoardRejectedReason, BoardStatus } from "@/types/database";

type Row = {
  id: string; child_name: string; mission_title: string; text: string; status: BoardStatus; created_at: string;
  rejected_reason?: BoardRejectedReason | null; delete_after?: string | null;
};

const STATUS: Record<BoardStatus, string> = {
  pending_permission: "Waiting for your permission",
  pending_moderation: "With WLA for review",
  published: "On the Mission Board",
  rejected: "Not added by WLA",
};

const linkButton =
  "inline-flex min-h-[var(--target-min)] items-center text-[length:var(--text-label)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-primary)]";

/**
 * MISSION BOARD PERMISSIONS (D-73) — where a parent permits a child's offer
 * and can withdraw anything, at any time. Withdrawal deletes it at once.
 * Shown only when there is something to decide or see; never a dashboard.
 */
export function BoardPermissions({ rows, nested = false }: { rows: Row[]; nested?: boolean }) {
  if (!rows.length) return null;
  const Heading = nested ? "h3" : "h2";
  return (
    <section aria-labelledby="board-permissions" className={nested ? "mt-[var(--space-l)]" : "mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-l)]"}>
      <Heading id="board-permissions" className={nested ? "font-medium" : "text-[length:var(--text-h3)]"}>Mission Board</Heading>
      <p className="mt-[var(--space-xs)] wla-measure text-[var(--color-text-muted)]">
        What your children have offered to share. Names and details are taken out, WLA reviews everything first,
        and you can take anything back at any time.
      </p>
      <ul className="mt-[var(--space-m)] border-t border-[var(--color-border)]">
        {rows.map((r) => (
          <li key={r.id} className="border-b border-[var(--color-border)] py-[var(--space-l)]">
            <p className="text-[length:var(--text-label)] font-medium text-[var(--color-text-muted)]">
              {r.child_name} · {r.mission_title} ·{" "}
              {r.status === "rejected" && r.rejected_reason === "cannot_anonymise" ? "Kept private by WLA" : STATUS[r.status]}
            </p>
            {r.status === "rejected" && (
              <p className="mt-[var(--space-xs)] text-[length:var(--text-small)]">
                {r.rejected_reason === "cannot_anonymise"
                  ? "WLA couldn't make this anonymous enough to share, so it stays private."
                  : "WLA didn't add this to the Board."}{" "}
                {r.delete_after
                  ? `This copy will be deleted on ${new Date(r.delete_after).toLocaleDateString("en-GB")}. The Trail entry itself stays.`
                  : "This copy will be deleted within 30 days. The Trail entry itself stays."}
              </p>
            )}
            <p className="wla-measure mt-[var(--space-xs)] whitespace-pre-line">{r.text}</p>
            <p className="mt-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">This is the copy WLA would see, with names and details removed.</p>
            <div className="mt-[var(--space-s)] flex flex-wrap gap-[var(--space-l)]">
              {r.status === "pending_permission" && (
                <>
                  <form action={permitBoardAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="allow" value="yes" />
                    <button type="submit" className={linkButton}>Allow WLA to review it</button>
                  </form>
                  <form action={permitBoardAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="allow" value="no" />
                    <button type="submit" className={linkButton}>Don&rsquo;t share it</button>
                  </form>
                </>
              )}
              {r.status !== "pending_permission" && (
                <form action={withdrawBoardAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" className={linkButton}>{r.status === "published" ? "Take it off the Board" : "Withdraw it"}</button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
