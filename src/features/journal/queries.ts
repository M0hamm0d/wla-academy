import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import { requireJournalStaff } from "@/lib/permissions/journal";
import { logWarn } from "@/lib/observability/logger";
import type {
  JournalArticleRow,
  JournalAssignmentRow,
  JournalAuditRow,
  JournalCategoryRow,
  JournalChangeRow,
  JournalCommentRow,
  JournalDecisionRow,
  JournalImportItemRow,
  JournalImportRunRow,
  JournalMediaRow,
  JournalMemberRow,
  JournalPreviewLinkRow,
  JournalRevisionRow,
  JournalRole,
} from "@/types/database";
import { articleStatus } from "./status";

/* Categories are public data (RLS: readable by anyone); the studio lists them here. */
export const getCategories = cache(async (): Promise<JournalCategoryRow[]> => {
  const supabase = await createClient();
  const { data } = await supabase.from("journal_categories").select("*").order("sort_order").order("name");
  return (data ?? []) as JournalCategoryRow[];
});

/* ============================================================== STUDIO ==
 * Staff reads go through RLS (journal_can_view): a writer sees their own
 * articles, a reviewer the ones assigned to them, an editor everything.
 */

export type StaffPerson = { profile_id: string; name: string | null; email: string; roles: JournalRole[]; is_admin: boolean };

export const getStaffDirectory = cache(async (): Promise<StaffPerson[]> => {
  const { supabase } = await requireJournalStaff();
  const { data, error } = await supabase.rpc("journal_staff_directory", {});
  if (error) logWarn("journal_staff_directory_failed", { reason: error.message });
  return (data ?? []) as StaffPerson[];
});

export type StudioListItem = {
  article: JournalArticleRow;
  working: Pick<JournalRevisionRow, "id" | "state" | "title" | "slug" | "updated_at" | "number"> | null;
  live: Pick<JournalRevisionRow, "id" | "title" | "slug"> | null;
  status: ReturnType<typeof articleStatus>;
  imported: boolean;
};

/** Tags on the articles this person can see, offered as suggestions. */
export async function getKnownTags(): Promise<string[]> {
  const { supabase } = await requireJournalStaff();
  const { data } = await supabase.from("journal_revisions").select("tags").order("updated_at", { ascending: false }).limit(500);
  return [...new Set((data ?? []).flatMap((r) => r.tags ?? []))].sort();
}

export async function listStudioArticles(): Promise<StudioListItem[]> {
  const { supabase } = await requireJournalStaff();
  const { data: articles } = await supabase.from("journal_articles").select("*").order("updated_at", { ascending: false });
  const list = (articles ?? []) as JournalArticleRow[];
  const ids = list.flatMap((a) => [a.working_revision_id, a.live_revision_id]).filter((x): x is string => Boolean(x));
  const { data: revs } = ids.length
    ? await supabase.from("journal_revisions").select("id, state, title, slug, updated_at, number, source_url").in("id", ids)
    : { data: [] };
  const byId = new Map((revs ?? []).map((r) => [r.id, r]));
  return list.map((article) => {
    const working = article.working_revision_id ? byId.get(article.working_revision_id) ?? null : null;
    const live = article.live_revision_id ? byId.get(article.live_revision_id) ?? null : null;
    return {
      article,
      working,
      live,
      status: articleStatus(article, working),
      imported: Boolean(working?.source_url),
    };
  });
}

export type StudioArticle = {
  article: JournalArticleRow;
  revisions: JournalRevisionRow[];
  working: JournalRevisionRow | null;
  live: JournalRevisionRow | null;
  members: JournalMemberRow[];
  assignments: JournalAssignmentRow[];
  decisions: JournalDecisionRow[];
  comments: JournalCommentRow[];
  changes: JournalChangeRow[];
  audit: JournalAuditRow[];
  media: JournalMediaRow[];
  /** Working (unrevoked, unexpired) preview links — never their tokens (D-134). */
  previewLinks: JournalPreviewLinkRow[];
  status: ReturnType<typeof articleStatus>;
};

export async function getStudioArticle(id: string): Promise<StudioArticle | null> {
  const { supabase } = await requireJournalStaff();
  const { data: article } = await supabase.from("journal_articles").select("*").eq("id", id).maybeSingle();
  if (!article) return null; // not found OR not visible to this person — same answer
  const a = article as JournalArticleRow;
  const [revisions, members, assignments, decisions, comments, audit, media, links] = await Promise.all([
    supabase.from("journal_revisions").select("*").eq("article_id", id).order("number", { ascending: false }),
    supabase.from("journal_article_members").select("*").eq("article_id", id),
    supabase.from("journal_review_assignments").select("*").eq("article_id", id),
    supabase.from("journal_review_decisions").select("*").eq("article_id", id).order("decided_at", { ascending: false }),
    supabase.from("journal_comments").select("*").eq("article_id", id).order("created_at"),
    supabase.from("journal_audit").select("*").eq("article_id", id).order("at", { ascending: false }).limit(100),
    supabase.from("journal_media").select("*").eq("article_id", id).order("created_at", { ascending: false }),
    supabase
      .from("journal_preview_links")
      .select("id, article_id, created_by, created_at, expires_at, revoked_at, revoked_by")
      .eq("article_id", id)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);
  const revs = (revisions.data ?? []) as JournalRevisionRow[];
  const revIds = revs.map((r) => r.id);
  const { data: changes } = revIds.length
    ? await supabase.from("journal_revision_changes").select("*").in("revision_id", revIds).order("at", { ascending: false }).limit(200)
    : { data: [] };
  const working = revs.find((r) => r.id === a.working_revision_id) ?? null;
  const live = revs.find((r) => r.id === a.live_revision_id) ?? null;
  return {
    article: a,
    revisions: revs,
    working,
    live,
    members: (members.data ?? []) as JournalMemberRow[],
    assignments: (assignments.data ?? []) as JournalAssignmentRow[],
    decisions: (decisions.data ?? []) as JournalDecisionRow[],
    comments: (comments.data ?? []) as JournalCommentRow[],
    changes: (changes ?? []) as JournalChangeRow[],
    audit: (audit.data ?? []) as JournalAuditRow[],
    media: (media.data ?? []) as JournalMediaRow[],
    previewLinks: (links.data ?? []) as JournalPreviewLinkRow[],
    status: articleStatus(a, working),
  };
}

export type SchedulerStatus = { configured: boolean; active: boolean; last_run_at: string | null; last_status: string | null; overdue: number };

/**
 * Is automatic publishing running (D-132)? Editors only — anyone else gets
 * null and the studio shows nothing. Never publishes anything itself.
 */
export async function getSchedulerStatus(): Promise<SchedulerStatus | null> {
  const { supabase, caps } = await requireJournalStaff();
  if (!caps.isEditor) return null;
  const { data, error } = await supabase.rpc("journal_scheduler_status", {});
  if (error) {
    logWarn("journal_scheduler_status_failed", { reason: error.message });
    return null;
  }
  return ((data ?? []) as SchedulerStatus[])[0] ?? null;
}

export async function listImportRuns(): Promise<JournalImportRunRow[]> {
  const { supabase } = await requireJournalStaff();
  const { data } = await supabase.from("journal_import_runs").select("*").order("started_at", { ascending: false }).limit(20);
  return (data ?? []) as JournalImportRunRow[];
}

export async function getImportRun(id: string): Promise<{ run: JournalImportRunRow; items: JournalImportItemRow[] } | null> {
  const { supabase } = await requireJournalStaff();
  const { data: run } = await supabase.from("journal_import_runs").select("*").eq("id", id).maybeSingle();
  if (!run) return null;
  const { data: items } = await supabase.from("journal_import_items").select("*").eq("run_id", id).order("id");
  return { run: run as JournalImportRunRow, items: (items ?? []) as JournalImportItemRow[] };
}
