import { AdminPage, StatusTag } from "@/components/admin/admin-page";
import { Button } from "@/components/ui/button";
import {
  saveReviewDetailsAction,
  setReviewStatusAction,
} from "@/features/admin/review-actions";
import { getAdminReviews } from "@/features/admin/review-queries";

export const metadata = { title: "Reviews" };

type Review = Awaited<ReturnType<typeof getAdminReviews>>[number];

const sections: { status: Review["status"]; title: string }[] = [
  { status: "pending", title: "Waiting for review" },
  { status: "published", title: "Published" },
  { status: "declined", title: "Declined" },
];

function ReviewEntry({ review }: { review: Review }) {
  const date = new Date(review.submitted_at);

  return (
    <li className="rounded-[var(--radius-surface)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-m)] sm:p-[var(--space-l)]">
      <div className="flex flex-col gap-[var(--space-s)] sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-[var(--space-m)] gap-y-[var(--space-xs)]">
            <h3 className="text-[length:var(--text-h3)] leading-tight">
              Review from {review.display_name}
            </h3>
            <span
              role="img"
              aria-label={`${review.rating} out of 5 stars`}
              className="text-[color:var(--color-text-accent)]"
            >
              {"★".repeat(review.rating)}
              {"☆".repeat(5 - review.rating)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-[var(--space-s)] text-[length:var(--text-small)]">
          <StatusTag status={review.status} />
          <span className="text-[var(--color-text-muted)]">
            Submitted{" "}
            <time dateTime={review.submitted_at}>
              {date.toLocaleDateString("en-GB", { dateStyle: "medium" })}
            </time>
          </span>
        </div>
      </div>

      <blockquote className="mt-[var(--space-m)] max-w-prose leading-relaxed break-words whitespace-pre-wrap text-[var(--color-text)]">
        {review.body}
      </blockquote>

      <dl className="mt-[var(--space-l)] grid min-w-0 gap-x-[var(--space-m)] gap-y-[var(--space-m)] text-[length:var(--text-small)] sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[var(--color-text-muted)]">Public attribution</dt>
          <dd className="mt-[var(--space-xs)] break-words">
            {review.display_name}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[var(--color-text-muted)]">Mission</dt>
          <dd className="mt-[var(--space-xs)] break-words">
            {review.mission_name ?? review.mission_slug ?? "Not specified"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[var(--color-text-muted)]">Consent to publish</dt>
          <dd className="mt-[var(--space-xs)]">
            {review.consent ? "Given" : "Not given"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[var(--color-text-muted)]">
            Parent contact (admin only)
          </dt>
          <dd className="mt-[var(--space-xs)] break-words">
            {[review.reviewer_name, review.reviewer_email]
              .filter(Boolean)
              .join(" · ") || "Not provided"}
          </dd>
        </div>
      </dl>

      <p className="mt-[var(--space-l)] max-w-prose text-[length:var(--text-small)] leading-relaxed text-[var(--color-text-muted)]">
        Check that the review contains no identifying or mission-specific
        details before publishing. Contact details and admin notes are not shown
        publicly.
      </p>

      <form
        action={saveReviewDetailsAction}
        className="mt-[var(--space-l)] grid gap-[var(--space-m)] border-t border-[var(--color-border)] pt-[var(--space-l)]"
      >
        <input type="hidden" name="id" value={review.id} />
        <label
          htmlFor={`notes-${review.id}`}
          className="leading-tight font-medium"
        >
          Private admin notes
        </label>
        <textarea
          id={`notes-${review.id}`}
          name="admin_notes"
          rows={3}
          maxLength={2000}
          defaultValue={review.admin_notes ?? ""}
          className="min-h-28 w-full rounded-[var(--radius-input)] border border-[var(--color-border-strong)] bg-[var(--color-background)] px-[var(--space-m)] py-[var(--space-s)] leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
        />
        <div className="grid gap-x-[var(--space-l)] gap-y-[var(--space-xs)] sm:grid-cols-2">
          <label className="inline-flex min-h-[var(--target-min)] items-center gap-[var(--space-s)]">
            <input
              type="checkbox"
              name="verified"
              defaultChecked={review.verified}
              className="h-5 w-5 shrink-0 accent-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
            />
            Participation or purchase verified
          </label>
          <label className="inline-flex min-h-[var(--target-min)] items-center gap-[var(--space-s)]">
            <input
              type="checkbox"
              name="featured"
              defaultChecked={review.featured}
              className="h-5 w-5 shrink-0 accent-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
            />
            Feature on the public reviews page
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-[var(--space-m)]">
          <label
            htmlFor={`order-${review.id}`}
            className="text-[length:var(--text-small)]"
          >
            Featured order (lower numbers appear first)
          </label>
          <input
            id={`order-${review.id}`}
            name="featured_order"
            type="number"
            min={0}
            max={9999}
            step={1}
            defaultValue={review.featured_order}
            className="min-h-[var(--target-min)] w-32 rounded-[var(--radius-input)] border border-[var(--color-border-strong)] bg-[var(--color-background)] px-[var(--space-s)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
          />
        </div>
        <div>
          <Button type="submit" variant="secondary">
            Save review details
          </Button>
        </div>
      </form>

      <form
        action={setReviewStatusAction}
        className="mt-[var(--space-l)] flex flex-col gap-[var(--space-s)] border-t border-[var(--color-border)] pt-[var(--space-m)] sm:flex-row sm:items-center sm:justify-between"
      >
        <input type="hidden" name="id" value={review.id} />
        <span className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
          Review status
        </span>
        <div className="flex flex-wrap gap-[var(--space-s)]">
          {review.status !== "published" && review.consent && (
            <Button type="submit" name="status" value="published">
              Publish review
            </Button>
          )}
          {review.status !== "pending" && (
            <Button
              type="submit"
              name="status"
              value="pending"
              variant="secondary"
            >
              Return to pending
            </Button>
          )}
          {review.status !== "declined" && (
            <Button
              type="submit"
              name="status"
              value="declined"
              variant="secondary"
            >
              Decline review
            </Button>
          )}
        </div>
      </form>
    </li>
  );
}

export default async function AdminReviewsPage() {
  const reviews = await getAdminReviews();

  return (
    <AdminPage
      title="Reviews"
      intro="Check parent-submitted reviews before publication. Reviews without publication consent cannot be published."
    >
      {reviews.length === 0 ? (
        <p className="text-[var(--color-text-muted)]">
          No reviews have been submitted yet.
        </p>
      ) : (
        sections.map(({ status, title }) => {
          const items = reviews.filter((review) => review.status === status);
          return (
            <section
              key={status}
              aria-labelledby={`reviews-${status}`}
              className="mt-[var(--space-2xl)] border-t border-[var(--color-border)] pt-[var(--space-xl)] first:mt-0 first:border-0 first:pt-0"
            >
              <h2
                id={`reviews-${status}`}
                className="text-[length:var(--text-h2)]"
              >
                {title} ({items.length})
              </h2>
              {items.length === 0 ? (
                <p className="mt-[var(--space-s)] text-[var(--color-text-muted)]">
                  Nothing here.
                </p>
              ) : (
                <ul className="mt-[var(--space-m)] grid gap-[var(--space-m)]">
                  {items.map((review) => (
                    <ReviewEntry key={review.id} review={review} />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </AdminPage>
  );
}
