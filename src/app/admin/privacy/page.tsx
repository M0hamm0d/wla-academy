import { AdminPage, DataTable, Td } from "@/components/admin/admin-page";
import { AdminCloseAccountForm, PlaceHoldForm } from "@/components/admin/privacy-forms";
import { Button } from "@/components/ui/button";
import {
  adminRetryClosuresAction,
  adminRetryOneClosureAction,
  adminReviewHoldAction,
} from "@/features/privacy/actions";
import { ledgerConfig } from "@/features/privacy/ledger";
import { requireAdmin } from "@/lib/permissions";

export const metadata = { title: "Privacy" };

const date = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

const STATUS: Record<string, string> = {
  in_progress: "In progress",
  held: "Held",
  failed: "Failed — will retry",
  completed: "Completed",
};

/**
 * PRIVACY (D-148). The operational evidence for account closure and retention:
 * every closure with its step, attempts and error code; anything overdue
 * against the 30-day target; the documented exceptions (holds) and their
 * annual review; and what each daily retention run removed.
 *
 * Ids, dates and counts only: a closed family's name or address is not kept,
 * so it can't be shown. Nothing here edits a family's data directly.
 */
export default async function PrivacyAdminPage() {
  const { supabase } = await requireAdmin();
  const [{ data: deletions }, { data: holds }, { data: runs }, { data: ledgerRows }] = await Promise.all([
    supabase.rpc("admin_privacy_deletions", {}),
    supabase.rpc("admin_retention_holds", {}),
    supabase.rpc("admin_retention_runs", { p_limit: 14 }),
    supabase.rpc("admin_privacy_ledger_status", {}),
  ]);
  const ledger = ledgerConfig().state;
  const ledgerStatus = ledgerRows?.[0];
  const waiting = Number(ledgerStatus?.unshipped ?? 0);
  const open = (deletions ?? []).filter((d) => d.status !== "completed");
  const overdue = open.filter((d) => d.overdue).length;

  return (
    <AdminPage
      title="Privacy"
      intro="Account closures, retention holds and the daily retention run. Ids, dates and counts only."
    >
      <section aria-labelledby="closures">
        <h2 id="closures" className="text-[length:var(--text-h3)]">
          Closures and deletions ({open.length} open{overdue ? `, ${overdue} overdue` : ""})
        </h2>
        <form action={adminRetryClosuresAction} className="mt-[var(--space-s)]">
          <Button type="submit" variant="secondary">Retry everything open</Button>
        </form>
        {(deletions ?? []).length === 0 ? (
          <p className="mt-[var(--space-s)] text-[var(--color-text-muted)]">None in the last 90 days.</p>
        ) : (
          <div className="mt-[var(--space-m)]">
            <DataTable
              caption="Closures and deletions"
              columns={["Requested", "What", "By", "Status", "Step", "Attempts", "Last error", "Files left", "Due by", "Completed", ""]}
            >
              {(deletions ?? []).map((d) => (
                <tr key={d.id}>
                  <Td>{date(d.requested_at)}</Td>
                  <Td>{d.subject_type === "parent_account" ? `Account (${d.children} children)` : "Child profile"}</Td>
                  <Td>{d.requested_by === "admin" ? "WLA" : "Family"}</Td>
                  <Td>{STATUS[d.status] ?? d.status}{d.overdue ? " · overdue" : ""}</Td>
                  <Td>{d.step}</Td>
                  <Td>{d.attempts}</Td>
                  <Td>{d.last_error ?? "—"}</Td>
                  <Td>{d.files_pending}</Td>
                  <Td>{date(d.due_by)}</Td>
                  <Td>{date(d.completed_at)}</Td>
                  <Td>
                    {(d.status === "failed" || d.status === "in_progress") && (
                      <form action={adminRetryOneClosureAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <Button type="submit" variant="text">Retry</Button>
                      </form>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
      </section>

      <section aria-labelledby="ledger" className="mt-[var(--space-2xl)]">
        <h2 id="ledger" className="text-[length:var(--text-h3)]">Deletion ledger outside the database</h2>
        <p className="wla-measure mt-[var(--space-s)]">
          {ledger === "unconfigured"
            ? "Not set up. Closures still run, but if the database were restored from an older backup, families deleted since that backup could come back with no record that they asked to go. WLA must choose where the ledger is kept (OPEN-30)."
            : ledger === "misconfigured"
              ? "Set up incorrectly: one of its two settings is missing or the key is invalid. Closures are paused, and nothing is deleted, until it is fixed."
              : waiting > 0
                ? `${waiting} ${waiting === 1 ? "entry is" : "entries are"} waiting to be copied, the oldest from ${date(ledgerStatus?.oldest_unshipped ?? null)}. Closures delete nothing until their request is copied.`
                : "Up to date. Every closure, hold and removal is copied before anything is deleted."}
        </p>
        <p className="wla-measure mt-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
          After any restore, follow the restore procedure before reopening the Academy (Privacy operations, §3).
        </p>
      </section>

      <section aria-labelledby="erasure" className="mt-[var(--space-2xl)]">
        <h2 id="erasure" className="text-[length:var(--text-h3)]">Close an account for an erasure request</h2>
        <p className="wla-measure mt-[var(--space-s)] text-[var(--color-text-muted)]">
          For a request made to WLA directly and verified outside the Academy. Families close their own
          accounts from Account. The account stops working at once.
        </p>
        <div className="mt-[var(--space-m)]">
          <AdminCloseAccountForm />
        </div>
      </section>

      <section aria-labelledby="holds" className="mt-[var(--space-2xl)]">
        <h2 id="holds" className="text-[length:var(--text-h3)]">Retention holds ({(holds ?? []).length})</h2>
        <p className="wla-measure mt-[var(--space-s)] text-[var(--color-text-muted)]">
          A hold keeps records that must lawfully be kept, or pauses log pruning for an investigation.
          Each is reviewed at least once a year: renew it or release it.
        </p>
        {(holds ?? []).length > 0 && (
          <div className="mt-[var(--space-m)]">
            <DataTable caption="Retention holds" columns={["Covers", "Id", "Reason", "Placed", "Review by", ""]}>
              {(holds ?? []).map((h) => (
                <tr key={h.id}>
                  <Td>{h.subject_type.replace("_", " ")}</Td>
                  <Td>{h.subject_id ?? "—"}</Td>
                  <Td>{h.reason}</Td>
                  <Td>{date(h.placed_at)}</Td>
                  <Td>{date(h.review_by)}{h.review_due ? " · review due" : ""}</Td>
                  <Td>
                    <form action={adminReviewHoldAction} className="flex gap-[var(--space-xs)]">
                      <input type="hidden" name="id" value={h.id} />
                      <Button type="submit" name="decision" value="renew" variant="text">Renew for a year</Button>
                      <Button type="submit" name="decision" value="release" variant="text">Release</Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
        <div className="mt-[var(--space-l)]">
          <PlaceHoldForm />
        </div>
      </section>

      <section aria-labelledby="runs" className="mt-[var(--space-2xl)]">
        <h2 id="runs" className="text-[length:var(--text-h3)]">Daily retention runs</h2>
        {(runs ?? []).length === 0 ? (
          <p className="mt-[var(--space-s)] text-[var(--color-text-muted)]">
            No run recorded yet. It runs daily at 03:15 UTC where pg_cron is enabled.
          </p>
        ) : (
          <ul className="mt-[var(--space-s)] flex flex-col gap-[var(--space-xs)] text-[length:var(--text-small)]">
            {(runs ?? []).map((r) => (
              <li key={r.ran_at}>
                <span className="font-medium">{new Date(r.ran_at).toLocaleString("en-GB")}</span>{" "}
                {Object.entries((r.results ?? {}) as Record<string, unknown>)
                  .map(([k, v]) => `${k.replaceAll("_", " ")}: ${String(v)}`)
                  .join(" · ")}
                {r.error ? ` · error: ${r.error}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AdminPage>
  );
}
