"use server";

import { revalidatePath } from "next/cache";
import { logError } from "@/lib/observability/logger";
import { requireAdmin } from "@/lib/permissions";
import {
  reviewDetailsSchema,
  reviewStatusChangeSchema,
} from "./review-schemas";

const REVIEWS_PATH = "/admin/reviews";

export async function setReviewStatusAction(formData: FormData): Promise<void> {
  const { supabase } = await requireAdmin();
  const parsed = reviewStatusChangeSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
  });
  if (!parsed.success) throw new Error("Invalid review status update.");

  const { id, status } = parsed.data;
  let query = supabase
    .from("reviews")
    .update({
      status,
      verified: status === "published",
      published_at: status === "published" ? new Date().toISOString() : null,
    })
    .eq("id", id);

  if (status === "published") query = query.eq("consent", true);

  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    const ref = logError("admin_review_status_failed", error, { reviewId: id });
    throw new Error(`The review could not be updated. Reference ${ref}.`);
  }
  if (!data)
    throw new Error(
      "The review is unavailable or does not have publication consent.",
    );

  revalidatePath(REVIEWS_PATH);
}

export async function saveReviewDetailsAction(
  formData: FormData,
): Promise<void> {
  const { supabase } = await requireAdmin();
  const parsed = reviewDetailsSchema.safeParse({
    id: formData.get("id"),
    admin_notes: formData.get("admin_notes"),
    verified: formData.get("verified"),
    featured: formData.get("featured"),
    featured_order: formData.get("featured_order"),
  });
  if (!parsed.success) throw new Error("Invalid review details.");

  const { id, admin_notes, verified, featured, featured_order } = parsed.data;
  const { data, error } = await supabase
    .from("reviews")
    .update({
      admin_notes: admin_notes || null,
      verified,
      featured,
      featured_order,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    const ref = logError("admin_review_details_failed", error, {
      reviewId: id,
    });
    throw new Error(`The review details could not be saved. Reference ${ref}.`);
  }
  if (!data) throw new Error("The review is unavailable.");

  revalidatePath(REVIEWS_PATH);
}
