import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInForm } from "../sign-in-form";

vi.mock("@/features/auth/actions", () => ({
  signInAction: vi.fn(),
}));

describe("SignInForm account creation link", () => {
  it("hides account creation when the visitor came from My Missions", () => {
    render(
      <SignInForm next="/academy/my-missions" showCreateAccount={false} />,
    );

    expect(screen.queryByRole("link", { name: "Create one" })).toBeNull();
  });

  it("keeps account creation available in the purchase flow", () => {
    const next = "/purchase/six-names?gift=1";
    render(<SignInForm next={next} />);

    expect(
      screen.getByRole("link", { name: "Create one" }).getAttribute("href"),
    ).toBe(`/signup?next=${encodeURIComponent(next)}`);
  });

  it("keeps account creation available for other sign-in entry points", () => {
    render(<SignInForm />);

    expect(
      screen.getByRole("link", { name: "Create one" }).getAttribute("href"),
    ).toBe("/signup");
  });
});
