import Link from "next/link";
import {
  AdminPage,
  DataTable,
  Td,
  StatusTag,
} from "@/components/admin/admin-page";
import { NewMissionForm } from "@/components/admin/new-mission-form";
import { requireAdmin } from "@/lib/permissions";

export const metadata = { title: "Mission Builder" };

/**
 * MISSION BUILDER — the entry point (brief §11).
 *
 * Lists what is currently being built, and starts a new mission. The eleven
 * steps the brief describes are not eleven pages: Details is this form,
 * Structure/Screens/Decisions/Branches/Consequences are all the screen list
 * (they are the same objects, distinguished by screen TYPE — making them
 * separate destinations would suggest the engine treats them differently, and
 * it does not), and Completion, Review and Publish are sections of the
 * version's own page.
 */
export default async function BuilderIndexPage() {
  const { supabase } = await requireAdmin();

  const { data: drafts } = await supabase
    .from("mission_versions")
    .select("mission_id, version, status, updated_at")
    .in("status", ["draft", "in_review"])
    .order("updated_at", { ascending: false });

  const ids = [...new Set((drafts ?? []).map((d) => d.mission_id))];
  const { data: missions } = ids.length
    ? await supabase.from("missions").select("id, slug, title").in("id", ids)
    : { data: [] as { id: string; slug: string; title: string }[] };

  const byId = new Map((missions ?? []).map((m) => [m.id, m]));

  return (
    <AdminPage
      title="Mission Builder"
      intro="Build and review missions before they are published."
    >
      <p className="wla-measure mb-[var(--space-xl)] text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        New to the builder?{" "}
        <a
          href="/admin/help#building"
          className="inline-flex min-h-[var(--target-min)] items-center underline decoration-[var(--color-border-strong)] underline-offset-4"
        >
          Read how a mission is built
        </a>
        . Drafts are private: nothing here reaches a learner until a version is
        published.
      </p>

     <section className="mt-[var(--space-2xl)] mb-[var(--space-3xl)] max-w-[34rem]">
        <h2 className="text-[length:var(--text-h3)]">Start a new mission</h2>
        <p className="wla-measure mt-[var(--space-xs)] text-[var(--color-text-muted)]">
          This creates the mission, hidden from the catalogue, with an empty
          draft (version 1) to build in. You can change everything except the
          address later.
        </p>
        <div className="mt-[var(--space-l)]">
          <NewMissionForm />
        </div>
      </section>

      <section>
        <h2 className="text-[length:var(--text-h3)]">In progress</h2>
        <div className="mt-[var(--space-m)]">
          {(drafts ?? []).length === 0 ? (
            <p className="text-[var(--color-text-muted)]">
              Nothing is being built right now.
            </p>
          ) : (
            <DataTable
              caption="Drafts in progress"
              columns={["Mission", "Version", "Status", "Last change", ""]}
            >
              {(drafts ?? []).map((d) => {
                const m = byId.get(d.mission_id);
                if (!m) return null;
                return (
                  <tr key={`${d.mission_id}-${d.version}`}>
                    <Td>{m.title}</Td>
                    <Td>v{d.version}</Td>
                    <Td>
                      <StatusTag status={d.status} />
                    </Td>
                    <Td>
                      {new Date(d.updated_at).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                      })}
                    </Td>

                    <Td>
                      <Link
                        href={`/admin/builder/${m.slug}/${d.version}`}
                        className="inline-flex min-h-[var(--target-min)] items-center underline decoration-[var(--color-border-strong)] underline-offset-4"
                      >
                        Open
                        <span className="sr-only">
                          {" "}
                          {m.title} version {d.version}
                        </span>
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </div>
      </section>
    </AdminPage>
  );
}
