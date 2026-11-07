import "server-only";

import { requireOwnedChild, requireParent } from "@/lib/permissions";

/**
 * "Download saved work" (D-148): before closing an account or removing a child,
 * a family can keep what their children made. One self-contained HTML file —
 * readable offline, printable, no app needed — with each child's missions, their
 * Mission Trail and their saved responses.
 *
 * Read with the parent's own session, so RLS decides exactly as it does for the
 * Trail pages: nothing here can include another family's child. Files a Trail
 * entry points at are linked with a short-lived signed address, through the same
 * family-scoped storage policy.
 */
const FILE_LINK_SECONDS = 60 * 60;

type Child = { id: string; display_name: string; created_at: string };

export async function buildSavedWork(childId: string | null): Promise<{ filename: string; html: string }> {
  const { supabase } = await requireParent();
  let children: Child[];
  if (childId) {
    const { child } = await requireOwnedChild(childId);
    children = [{ id: child.id, display_name: child.display_name, created_at: child.created_at }];
  } else {
    const { data, error } = await supabase
      .from("child_profiles")
      .select("id, display_name, created_at")
      .order("created_at");
    if (error) throw error;
    children = data ?? [];
  }

  const sections: string[] = [];
  for (const child of children) sections.push(await childSection(supabase, child));

  const when = new Date().toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/London" });
  const title = childId && children[0] ? `${children[0].display_name}'s saved work` : "Your family's saved work";
  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Within Lab Academy</title>
<style>
body{font:16px/1.55 Georgia,serif;color:#3A2F2A;background:#F5EFE3;margin:0;padding:2rem 1rem}
main{max-width:46rem;margin:0 auto}h1,h2,h3{font-weight:500;line-height:1.2}
h2{margin-top:2.5rem;border-top:1px solid #cdbfa8;padding-top:1.5rem}
.meta{color:#6b5d54;font-size:.9rem}li{margin:.4rem 0}pre{white-space:pre-wrap;font:inherit}
section.mission{margin-top:1.5rem}@media print{body{background:#fff}a{color:inherit}}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="meta">Downloaded from Within Lab Academy on ${esc(when)}. Keep this file somewhere safe: it is a copy, and closing the account or removing a child doesn't change it.</p>
${sections.join("\n") || "<p>There are no child profiles on this account.</p>"}
</main></body></html>`;
  const slug = childId && children[0] ? slugify(children[0].display_name) : "family";
  return { filename: `wla-saved-work-${slug}-${new Date().toISOString().slice(0, 10)}.html`, html };
}

type Client = Awaited<ReturnType<typeof requireParent>>["supabase"];

async function childSection(supabase: Client, child: Child): Promise<string> {
  const [{ data: runs }, { data: evidence }] = await Promise.all([
    supabase
      .from("mission_progress")
      .select("id, mission_id, status, started_at, completed_at, missions(title)")
      .eq("child_id", child.id)
      .order("created_at"),
    supabase
      .from("mission_evidence")
      .select("id, mission_id, type, title, description, storage_path, created_at")
      .eq("child_id", child.id)
      .order("created_at"),
  ]);
  const runIds = (runs ?? []).map((r) => r.id);
  const { data: responses } = runIds.length
    ? await supabase.from("mission_responses").select("progress_id, screen_key, value, updated_at").in("progress_id", runIds)
    : { data: [] as { progress_id: string; screen_key: string; value: unknown; updated_at: string }[] };

  const paths = (evidence ?? []).map((e) => e.storage_path).filter((p): p is string => Boolean(p));
  const links = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("mission-evidence").createSignedUrls(paths, FILE_LINK_SECONDS);
    for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) links.set(s.path, s.signedUrl);
  }

  const missionIds = new Set<string>([
    ...(runs ?? []).map((r) => r.mission_id),
    ...(evidence ?? []).map((e) => e.mission_id),
  ]);
  const titleOf = new Map<string, string>(
    (runs ?? []).map((r) => [r.mission_id, (r.missions as unknown as { title: string } | null)?.title ?? "A mission"]),
  );

  const parts = [...missionIds].map((missionId) => {
    const run = (runs ?? []).find((r) => r.mission_id === missionId);
    const trail = (evidence ?? []).filter((e) => e.mission_id === missionId);
    const answers = (responses ?? []).filter((r) => run && r.progress_id === run.id);
    return `<section class="mission">
<h3>${esc(titleOf.get(missionId) ?? "A mission")}</h3>
${run ? `<p class="meta">${esc(statusWords(run.status))}${run.started_at ? ` · started ${esc(day(run.started_at))}` : ""}${run.completed_at ? ` · completed ${esc(day(run.completed_at))}` : ""}</p>` : ""}
${trail.length ? `<h4>Mission Trail</h4><ul>${trail.map((e) => `<li><strong>${esc(e.title)}</strong> <span class="meta">(${esc(day(e.created_at))}${e.type === "physical" ? ", made on paper" : ""})</span>${e.description ? `<pre>${esc(e.description)}</pre>` : ""}${e.storage_path ? (links.get(e.storage_path) ? `<p><a href="${esc(links.get(e.storage_path)!)}">Download the file</a> <span class="meta">(this link works for one hour)</span></p>` : `<p class="meta">A file was saved with this entry but couldn't be linked.</p>`) : ""}</li>`).join("")}</ul>` : ""}
${answers.length ? `<h4>Saved answers</h4><ul>${answers.map((a) => `<li>${renderValue(a.value)}</li>`).join("")}</ul>` : ""}
</section>`;
  });

  return `<h2>${esc(child.display_name)}</h2>
${parts.length ? parts.join("\n") : "<p>No missions started yet.</p>"}`;
}

function statusWords(status: string): string {
  return status === "complete" ? "Complete" : status === "in_progress" ? "In progress" : "Not started";
}

/** A saved answer is whatever its screen stored: words where there are words. */
function renderValue(value: unknown): string {
  const words: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.trim()) words.push(v.trim());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return words.length ? `<pre>${esc(words.join("\n"))}</pre>` : `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "child";
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
