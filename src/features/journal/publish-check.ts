import { slugProblem } from "./content";

/**
 * WHAT STOPS AN ARTICLE BEING PUBLISHED, BEFORE ASKING THE SERVER (D-147).
 *
 * The same rules the database applies (`private.journal_publish_problem`: title,
 * web address, text), and the one `publishAction` and `scheduleAction` apply (a
 * featured image needs a description; a draft doesn't yet). The server still
 * decides. This only lets the review say so sooner, next to the field. Image,
 * category, tags and excerpt stay optional.
 */
export const FEATURED_ALT_REQUIRED = "Describe the featured image for people who can't see it.";

export type PublishField = "title" | "body" | "slug" | "featured_alt" | "uploads";
export type PublishProblem = { field: PublishField; message: string };

export function publishProblems(a: {
  title: string;
  body: string;
  slug: string;
  featured: string;
  featuredAlt: string;
  pendingUploads: number;
}): PublishProblem[] {
  const problems: PublishProblem[] = [];
  if (!a.title.trim()) problems.push({ field: "title", message: "Give it a title." });
  if (!a.body.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()) {
    problems.push({ field: "body", message: "Write something first — the article has no text." });
  }
  if (!a.slug) problems.push({ field: "slug", message: "It needs a web address." });
  else {
    const slug = slugProblem(a.slug);
    if (slug) problems.push({ field: "slug", message: slug });
  }
  if (a.featured && !a.featuredAlt.trim()) {
    problems.push({ field: "featured_alt", message: FEATURED_ALT_REQUIRED });
  }
  if (a.pendingUploads > 0) {
    problems.push({ field: "uploads", message: "Wait for images to finish uploading, or remove any that failed." });
  }
  return problems;
}
