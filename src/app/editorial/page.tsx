import Link from "next/link";

import { AdminPage, DataTable, Td } from "@/components/admin/admin-page";
import { FormNotice } from "@/components/ui/field";
import { NewArticleButton } from "@/components/journal/studio/forms";
import { PublishNoticeToast } from "@/components/journal/studio/publish-notice";
import { getSchedulerStatus, listStudioArticles } from "@/features/journal/queries";
import { publishNotice } from "@/features/journal/publish-notice";
import { studioStatusWords } from "@/features/journal/status";
import { requireJournalStaff } from "@/lib/permissions/journal";

/** The four places an article can be (D-137). Old review states read as drafts. */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "scheduled", label: "Scheduled" },
  { key: "published", label: "Published" },
  { key: "archived", label: "Archived" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const bucket = (words: string): FilterKey =>
  words.startsWith("Published") ? "published" : words === "Scheduled" ? "scheduled" : words === "Archived" ? "archived" : "draft";

export default async function EditorialHome({ searchParams }: { searchParams: Promise<{ status?: string; notice?: string; article?: string }> }) {
  const sp = await searchParams;
  const { caps } = await requireJournalStaff();
  const [all, scheduler] = await Promise.all([listStudioArticles(), getSchedulerStatus()]);
  const filter: FilterKey = FILTERS.some((f) => f.key === sp.status) ? (sp.status as FilterKey) : "all";
  const words = new Map(all.map((r) => [r.article.id, studioStatusWords(r.status)]));
  const published = publishNotice(sp.notice, sp.article, all);
  const rows = filter === "all" ? all : all.filter((r) => bucket(words.get(r.article.id)!) === filter);

  return (
    <AdminPage
      title="Journal articles"
      intro={caps.isEditor ? "Every article. Nothing reaches the public Journal until someone publishes it." : "The articles you write. You can publish the ones you author."}
    >
      {scheduler && (!scheduler.configured || !scheduler.active || scheduler.overdue > 0) && (
        <p role="alert" className="mb-[var(--space-l)] wla-measure rounded-[var(--radius-input)] border border-[var(--color-error)] bg-[var(--color-surface)] p-[var(--space-m)]">
          {!scheduler.configured || !scheduler.active
            ? "Automatic publishing is not running on this database, so scheduled articles will not publish by themselves. See docs/JOURNAL-CMS.md → Scheduler."
            : `${scheduler.overdue} scheduled ${scheduler.overdue === 1 ? "article is" : "articles are"} past due: the automatic publisher may be behind. It catches up on its next run.`}
        </p>
      )}
      {published && <PublishNoticeToast notice={published} />}
      {sp.notice === "deleted" && <div className="mb-[var(--space-l)]"><FormNotice message="The draft was deleted." /></div>}
      {caps.canWrite && (
        <div className="mb-[var(--space-xl)]"><NewArticleButton /></div>
      )}

      <section aria-labelledby="articles">
        <h2 id="articles" className="text-[length:var(--text-h2)]">Articles</h2>
        <nav aria-label="Filter by status" className="mt-[var(--space-m)]">
          <ul className="flex flex-wrap gap-[var(--space-xs)]">
            {FILTERS.map(({ key: f, label }) => {
              const count = f === "all" ? all.length : all.filter((r) => bucket(words.get(r.article.id)!) === f).length;
              const current = f === filter;
              return (
                <li key={f}>
                  <Link
                    href={f === "all" ? "/editorial" : `/editorial?status=${f}`}
                    aria-current={current ? "page" : undefined}
                    className={`inline-flex min-h-[var(--target-min)] items-center rounded-[var(--radius-control)] border px-[var(--space-s)] text-[length:var(--text-small)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] ${current ? "border-[var(--color-text)] bg-[var(--color-surface-sage)] font-medium underline" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}
                  >
                    {label} ({count})
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {rows.length === 0 ? (
          <p className="mt-[var(--space-l)] text-[var(--color-text-muted)]">{all.length === 0 ? "No articles yet." : "No articles in this state."}</p>
        ) : (
          <div className="mt-[var(--space-l)]">
            <DataTable columns={["Article", "Status", "Last changed"]} caption="Journal articles">
              {rows.map((r) => (
                <tr key={r.article.id}>
                  <Td>
                    <Link href={`/editorial/articles/${r.article.id}`} className="font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]">
                      {r.working?.title || r.live?.title || "Untitled draft"}
                    </Link>
                    {r.imported && <span className="ml-[var(--space-xs)] text-[var(--color-text-muted)]">· Imported</span>}
                  </Td>
                  <Td>{words.get(r.article.id)}</Td>
                  <Td>{new Date(r.article.updated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</Td>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
      </section>
    </AdminPage>
  );
}
