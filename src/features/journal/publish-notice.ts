import { publicArticleUrl } from "./public-url";
import { formatLondon } from "./time";

/**
 * THE MESSAGE ON THE ARTICLES LIST AFTER PUBLISHING (D-147).
 *
 * The studio only comes here once the server has confirmed, and this checks again
 * against the row just read, so an address typed by hand can't announce something
 * that didn't happen. Null means no message.
 */
export type PublishNoticeRow = {
  article: { id: string; live_revision_id: string | null; scheduled_for: string | null };
  live: { id: string; title: string; slug: string } | null;
  working: { title: string } | null;
};

export type PublishNotice = {
  title: string;
  message: string;
  link: { href: string; label: string; external: boolean } | null;
};

export function publishNotice(
  notice: string | undefined,
  articleId: string | undefined,
  rows: PublishNoticeRow[],
): PublishNotice | null {
  const row = rows.find((r) => r.article.id === articleId);
  if (!row) return null;

  if (notice === "scheduled" && row.article.scheduled_for) {
    return {
      title: row.working?.title || "Your article",
      message: `Article scheduled. It will publish automatically on ${formatLondon(row.article.scheduled_for)}.`,
      link: null,
    };
  }
  if ((notice === "published" || notice === "updated") && row.article.live_revision_id && row.live) {
    const url = publicArticleUrl(row.live.slug);
    return {
      title: row.live.title,
      message:
        notice === "published"
          ? "Article published successfully. Your article is now live on the Journal."
          : "Article updated successfully. Your changes are now live on the Journal.",
      link: url
        ? { href: url, label: "View on the Journal", external: true }
        : { href: `/editorial/articles/${row.article.id}/preview?revision=${row.live.id}`, label: "Read the published article", external: false },
    };
  }
  return null;
}
