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

export default async function PrivacyAdminPage() {
  const { supabase } = await requireAdmin();
  const [
    { data: deletions },
    { data: holds },
    { data: runs },
    { data: ledgerRows, error: ledgerStatusError },
  ] = await Promise.all([
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
        <h2 id="closures" className="text-[length:var(--text-h3)]">Closures and deletions ({open.length} open{overdue ? `, ${overdue} overdue` : ""})</h2>
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
        <h2 id="ledger" className="text-[length:var(--text-h3)]">A separate record of privacy actions</h2>
        <p className="wla-measure mt-[var(--space-s)]">
          {ledgerStatusError
            ? "We couldn't check whether privacy actions have been safely copied. Please refresh this page or contact technical support. Do not treat this as up to date."
            : ledger === "unconfigured"
              ? "This protection isn't set up. If the Academy had to use an older database backup, it might not know which accounts or child profiles had already been deleted. In production, deletion requests are recorded, but the data removal waits until this protection is set up."
              : ledger === "misconfigured"
                ? "This protection isn't working because some setup details are missing or invalid. Deletion requests are recorded and the affected account or child is stopped from using the Academy, but the data removal waits until the problem is fixed."
                : waiting > 0
                  ? `${waiting} privacy ${waiting === 1 ? "update is" : "updates are"} waiting to be copied to the separate protected record. These updates can include deletion requests, holds, or Mission Board removals; they do not necessarily represent the same number of accounts being deleted. The oldest has been waiting since ${date(ledgerStatus?.oldest_unshipped ?? null)}. An account's data is not removed until its deletion request has been copied.`
                  : "All privacy updates currently waiting have been copied to the separate protected record. This helps the Academy remember what must stay deleted if an older database backup is restored."}
        </p>
        <p className="wla-measure mt-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
          If the Academy is restored from a backup, keep it closed until this
          separate record has been checked and any required deletions have been
          carried out again.
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
          <div
            role="region"
            aria-label="Retention run history"
            tabIndex={0}
            className="scrollbar-hidden mt-[var(--space-s)] max-h-[32rem] overflow-y-auto overscroll-contain border-y border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
          >
            <ul className="text-[length:var(--text-small)]">
              {(runs ?? []).map((r) => {
                const results = Object.entries((r.results ?? {}) as Record<string, unknown>);
                return (
                  <li key={r.ran_at} className="border-t border-[var(--color-border)] py-[var(--space-m)]">
                    <h3 className="font-medium">
                      Run on {new Date(r.ran_at).toLocaleString("en-GB")}
                    </h3>
                    {results.length > 0 ? (
                      <dl className="mt-[var(--space-s)] grid gap-x-[var(--space-m)] gap-y-[var(--space-xs)] sm:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.3fr)]">
                        {results.map(([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="text-[var(--color-text-muted)]">
                              {key.replaceAll("_", " ")}
                            </dt>
                            <dd className="min-w-0 whitespace-pre-wrap break-words">
                              {typeof value === "string"
                                ? value
                                : (JSON.stringify(value, null, 2) ?? String(value))}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-[var(--space-s)] text-[var(--color-text-muted)]">
                        No result details recorded.
                      </p>
                    )}
                    {r.error && (
                      <p className="mt-[var(--space-s)] whitespace-pre-wrap break-words">
                        <span className="font-medium">Run error: </span>
                        {r.error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </AdminPage>
  );
}
