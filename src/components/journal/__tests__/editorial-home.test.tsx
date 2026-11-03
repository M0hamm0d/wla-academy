import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/features/journal/actions", () => ({ newArticleAction: vi.fn() }));
vi.mock("@/components/journal/studio/forms", () => ({ NewArticleButton: () => null }));
vi.mock("@/lib/permissions/journal", () => ({ requireJournalStaff: async () => ({ caps: { isEditor: true, canWrite: true } }) }));
vi.mock("@/features/journal/queries", () => ({
  getSchedulerStatus: async () => null,
  listStudioArticles: async () => [
    {
      article: { id: "a1", live_revision_id: "r1", scheduled_for: null, archived_at: null, working_revision_id: "r1", updated_at: "2026-10-31T10:00:00Z" },
      working: { id: "r1", state: "live", title: "First light", slug: "first-light" },
      live: { id: "r1", title: "First light", slug: "first-light" },
      status: { status: "published", pending: null },
      imported: false,
    },
  ],
}));

import EditorialHome from "@/app/editorial/page";

describe("the Journal articles list, after publishing (D-147)", () => {
  it("shows the confirmation, and the article with its Published status", async () => {
    render(await EditorialHome({ searchParams: Promise.resolve({ notice: "published", article: "a1" }) }));
    expect(screen.getByRole("status")).toHaveTextContent("Article published successfully. Your article is now live on the Journal.");
    const row = screen.getByRole("link", { name: "First light" }).closest("tr")!;
    expect(within(row).getByText("Published")).toBeInTheDocument();
  });

  it("no confirmation without the server's word for it", async () => {
    render(await EditorialHome({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/published successfully/)).toBeNull();
  });
});
