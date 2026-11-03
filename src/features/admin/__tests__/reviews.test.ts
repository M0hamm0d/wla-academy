import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  isAdmin: true,
  notFound: false,
  fromCalls: 0,
  updateValues: null as Record<string, unknown> | null,
  filters: [] as { column: string; value: unknown }[],
}));

vi.mock("@/lib/permissions", () => {
  const query: Record<string, (...args: never[]) => unknown> = {};
  query.update = vi.fn((values: Record<string, unknown>) => {
    store.updateValues = values;
    return query;
  });
  query.eq = vi.fn((column: string, value: unknown) => {
    store.filters.push({ column, value });
    return query;
  });
  query.select = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({
    data: store.notFound
      ? null
      : { id: "11111111-2222-4333-8444-555555555555" },
    error: null,
  }));
  return {
    requireAdmin: async () => {
      if (!store.isAdmin) throw new Error("forbidden");
      return {
        supabase: {
          from: () => {
            store.fromCalls += 1;
            return query;
          },
        },
      };
    },
  };
});

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(() => "WLA-TEST"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { saveReviewDetailsAction, setReviewStatusAction } =
  await import("../review-actions");
const { reviewDetailsSchema, reviewStatusChangeSchema } =
  await import("../review-schemas");

const ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  store.isAdmin = true;
  store.notFound = false;
  store.fromCalls = 0;
  store.updateValues = null;
  store.filters = [];
});

describe("review moderation schemas", () => {
  it("accepts supported statuses and rejects arbitrary status input", () => {
    expect(
      reviewStatusChangeSchema.safeParse({ id: ID, status: "published" })
        .success,
    ).toBe(true);
    expect(
      reviewStatusChangeSchema.safeParse({ id: ID, status: "approved" })
        .success,
    ).toBe(false);
    expect(
      reviewStatusChangeSchema.safeParse({ id: "not-an-id", status: "pending" })
        .success,
    ).toBe(false);
  });

  it("validates notes and featured order and interprets unchecked boxes", () => {
    const result = reviewDetailsSchema.safeParse({
      id: ID,
      admin_notes: "",
      verified: null,
      featured: "on",
      featured_order: "3",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verified).toBe(false);
      expect(result.data.featured).toBe(true);
      expect(result.data.featured_order).toBe(3);
    }

    expect(
      reviewDetailsSchema.safeParse({
        id: ID,
        admin_notes: "",
        verified: null,
        featured: null,
        featured_order: "-1",
      }).success,
    ).toBe(false);
  });
});

describe("admin review actions", () => {
  it("requires admin authorization before touching reviews", async () => {
    store.isAdmin = false;
    const form = new FormData();
    form.set("id", ID);
    form.set("status", "published");

    await expect(setReviewStatusAction(form)).rejects.toThrow("forbidden");
    expect(store.fromCalls).toBe(0);
  });

  it("requires database consent before publishing", async () => {
    const form = new FormData();
    form.set("id", ID);
    form.set("status", "published");

    await setReviewStatusAction(form);

    expect(store.updateValues).toMatchObject({ status: "published" });
    expect(store.filters).toContainEqual({ column: "consent", value: true });
  });

  it("saves only validated review details and treats absent checkboxes as false", async () => {
    const form = new FormData();
    form.set("id", ID);
    form.set("admin_notes", "  checked  ");
    form.set("featured_order", "0");
    form.set("featured", "on");

    await saveReviewDetailsAction(form);

    expect(store.updateValues).toEqual({
      admin_notes: "checked",
      verified: false,
      featured: true,
      featured_order: 0,
    });
  });

  it("refuses to claim success when the review no longer exists", async () => {
    store.notFound = true;
    const form = new FormData();
    form.set("id", ID);
    form.set("status", "declined");

    await expect(setReviewStatusAction(form)).rejects.toThrow(
      "The review is unavailable",
    );
  });
});
