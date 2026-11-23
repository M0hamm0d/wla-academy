import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));

import { AppShell } from "../app-shell";

const logoutItem = { href: "/logout", label: "Log out", icon: null };

function renderShell(
  logoutAction?: () => Promise<void>,
  logoutHref = "/logout",
  logoutMessage?: string,
) {
  return render(
    <AppShell
      nav={[]}
      utility={[{ ...logoutItem, href: logoutHref }]}
      logoutAction={logoutAction}
      logoutMessage={logoutMessage}
    >
      <p>Admin content</p>
    </AppShell>,
  );
}

describe("shell logout confirmation", () => {
  it("keeps ordinary logout navigation unchanged when no action is provided", () => {
    renderShell();

    expect(
      screen.getByRole("link", { name: "Log out" }).getAttribute("href"),
    ).toBe("/logout");
  });

  it("opens a dialog and lets the user cancel without signing out", () => {
    const logoutAction = vi.fn(async () => {});
    renderShell(logoutAction);

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    const dialog = screen.getByRole("alertdialog", { name: "Log out?" });
    expect(
      within(dialog).getByText(/sign in again to manage your family/),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog", { name: "Log out?" })).toBeNull();
    expect(logoutAction).not.toHaveBeenCalled();
  });

  it("submits the sign-out action only after confirmation", async () => {
    const logoutAction = vi.fn(async () => {});
    renderShell(logoutAction);

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    const dialog = screen.getByRole("alertdialog", { name: "Log out?" });
    fireEvent.submit(
      within(dialog).getByRole("button", { name: "Log out" }).closest("form")!,
    );

    expect(logoutAction).toHaveBeenCalledTimes(1);
  });

  it("uses the supplied child sign-out action and message", () => {
    const childLogoutAction = vi.fn(async () => {});
    renderShell(
      childLogoutAction,
      "/child/logout",
      "You’ll need your child code to come back in.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    const dialog = screen.getByRole("alertdialog", { name: "Log out?" });
    expect(
      within(dialog).getByText("You’ll need your child code to come back in."),
    ).toBeDefined();
    fireEvent.submit(
      within(dialog).getByRole("button", { name: "Log out" }).closest("form")!,
    );

    expect(childLogoutAction).toHaveBeenCalledTimes(1);
  });
});
