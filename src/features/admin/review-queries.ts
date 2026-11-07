import "server-only";

import { logError } from "@/lib/observability/logger";
import { requireAdmin } from "@/lib/permissions";

export async function getAdminReviews() {
  const { supabase } = await requireAdmin();
  const { data, error, count } = await supabase
    .from("reviews")
    .select(
      "id, rating, body, mission_name, mission_slug, display_name, reviewer_name, reviewer_email, attribution, consent, status, verified, featured, featured_order, admin_notes, submitted_at, published_at",
    )
    .order("submitted_at", { ascending: false });

  if (error) {
    const ref = logError("admin_reviews_load_failed", error);
    throw new Error(`Reviews could not be loaded. Reference ${ref}.`);
  }

  return data ?? [];
}
