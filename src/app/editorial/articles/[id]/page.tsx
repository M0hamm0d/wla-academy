import { notFound } from "next/navigation";

import { History } from "@/components/journal/studio/history";
import { ArticleStudio } from "@/components/journal/studio/article-studio";
import { CommentsPanel } from "@/components/journal/studio/side-panels";
import { getCategories, getKnownTags, getSchedulerStatus, getStaffDirectory, getStudioArticle } from "@/features/journal/queries";
import { journalSiteOrigin, publicArticleUrl } from "@/features/journal/public-url";
import { studioStatusWords } from "@/features/journal/status";
import { formatLondon } from "@/features/journal/time";
import { requireJournalStaff } from "@/lib/permissions/journal";

export const metadata = { title: "Article · Journal studio" };

const UUID = /^[0-9a-f-]{36}$/;

/**
 * ONE ARTICLE IN THE STUDIO (D-137). Everything here is read through RLS as
 * the signed-in person, so someone who opens an article id they may not see
 * gets the same "not found" as a bad id. What they may DO is decided again
 * by the database on every action.
 */
export default async function StudioArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { caps, user } = await requireJournalStaff();
  const [data, staff, categories, scheduler, knownTags] = await Promise.all([getStudioArticle(id), getStaffDirectory(), getCategories(), getSchedulerStatus(), getKnownTags()]);
  if (!data) notFound();

  const { article, working, live, revisions, members, decisions, comments, changes, audit, media, previewLinks, status } = data;
  if (!working) notFound();
  const people = new Map(staff.map((p) => [p.profile_id, p.name || p.email]));
  const nameOf = (pid: string | null) => (pid ? people.get(pid) ?? "Former staff" : "Someone");
  const me = user.id;
  const isMember = members.some((m) => m.profile_id === me);
  const isAuthor = members.some((m) => m.profile_id === me && m.role === "author");
  const canEdit = caps.isEditor || (caps.canWrite && isMember);
  // D-130: editors, or a writer who is this article's author, publish. No approval.
  const canPublish = caps.isEditor || (caps.canWrite && isAuthor);
  const archived = Boolean(article.archived_at);
  const scheduledLocked = Boolean(article.scheduled_revision_id && article.scheduled_revision_id === working.id);

  const lockedReason = archived
    ? "This article is archived: it's off the public Journal and can't be edited."
    : scheduledLocked
      ? `Scheduled to publish on ${formatLondon(article.scheduled_for!)}. Cancel the schedule to make changes.`
      : !canEdit
        ? "You can read this article, but you aren't one of its writers, so you can't edit it."
        : null;

  return (
    <ArticleStudio
      key={id}
      articleId={id}
      revision={{
        id: working.id,
        number: working.number,
        state: working.state,
        lock_version: working.lock_version,
        content_hash: working.content_hash,
        title: working.title,
        slug: working.slug,
        excerpt: working.excerpt,
        body_html: working.body_html,
        author_name: working.author_name,
        category_id: working.category_id,
        tags: working.tags,
        featured_media_id: working.featured_media_id,
        featured_alt: working.featured_alt,
        seo_title: working.seo_title,
        seo_description: working.seo_description,
        canonical_url: working.canonical_url,
        original_published_at: working.original_published_at,
      }}
      lockedReason={lockedReason}
      statusWords={studioStatusWords(status)}
      live={
        live
          ? {
              revisionId: live.id,
              number: live.number,
              slug: live.slug,
              // D-137: readers are on the public website (Lovable), never /journal here.
              publicUrl: publicArticleUrl(live.slug),
              studioViewHref: `/editorial/articles/${id}/preview?revision=${live.id}`,
            }
          : null
      }
      scheduled={article.scheduled_for ? { at: article.scheduled_for, by: nameOf(article.scheduled_by) } : null}
      scheduler={scheduler ? { configured: scheduler.configured, active: scheduler.active, overdue: scheduler.overdue } : null}
      canPublish={canPublish}
      isEditor={caps.isEditor}
      archived={archived}
      everPublished={Boolean(article.first_published_at)}
      publicSiteOrigin={journalSiteOrigin()}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      knownTags={knownTags}
      media={media.map((m) => ({ id: m.id, alt: m.alt_text }))}
      previewLinks={previewLinks.map((l) => ({ id: l.id, createdAt: l.created_at, expiresAt: l.expires_at, by: nameOf(l.created_by) }))}
      people={{
        members: members.map((m) => ({ id: m.profile_id, name: nameOf(m.profile_id), role: m.role })),
        writers: staff.filter((p) => p.is_admin || p.roles.includes("writer") || p.roles.includes("editor")).map((p) => ({ id: p.profile_id, name: p.name || p.email })),
        canManage: !archived && (caps.isEditor || isAuthor),
      }}
      commentCount={comments.filter((c) => !c.parent_id && !c.resolved_at).length}
      comments={
        <CommentsPanel
          articleId={id}
          revisionId={working.id}
          comments={comments.map((c) => ({
            id: c.id,
            parentId: c.parent_id,
            author: nameOf(c.author_id),
            body: c.body,
            anchor: c.anchor,
            revisionNumber: revisions.find((r) => r.id === c.revision_id)?.number ?? null,
            createdAt: c.created_at,
            resolved: Boolean(c.resolved_at),
            canResolve: canEdit || c.author_id === me,
          }))}
        />
      }
      history={<History articleId={id} revisions={revisions} changes={changes} decisions={decisions} audit={audit} nameOf={nameOf} />}
    />
  );
}
