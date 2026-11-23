import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

vi.mock("@/features/auth/actions", () => ({
  signInAction: vi.fn(),
}));

async function renderLoginPage(next: string) {
  const page = await LoginPage({
    searchParams: Promise.resolve({ next }),
  });
  render(page);
}

describe("My Missions sign-in options", () => {
  it("shows child access and mission exploration links", async () => {
    await renderLoginPage("/academy/my-missions");

    expect(screen.getByText("For parents and guardians.")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Enter Child Access Code" })
        .getAttribute("href"),
    ).toBe("/child/login");
    expect(screen.getByText("New to WLA?")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Explore Missions" })
        .getAttribute("href"),
    ).toBe("/missions");
    expect(screen.queryByRole("link", { name: "Create one" })).toBeNull();
  });

  it("keeps the purchase sign-in flow unchanged", async () => {
    await renderLoginPage("/purchase/six-names");

    expect(
      screen.getByRole("link", { name: "Create one" }).getAttribute("href"),
    ).toBe("/signup?next=%2Fpurchase%2Fsix-names");
    expect(
      screen.queryByRole("link", { name: "Enter Child Access Code" }),
    ).toBeNull();
    expect(screen.queryByText("New to WLA?")).toBeNull();
  });
});
