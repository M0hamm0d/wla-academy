import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/features/commerce/actions", () => ({ acquireMissionAction: vi.fn() }));
vi.mock("@/features/gifts/actions", () => ({ giftMissionAction: vi.fn() }));

import { PurchasePanel } from "../purchase-panel";

const base = {
  missionSlug: "six-names",
  missionTitle: "Six Names",
  priceLabel: "£12.00",
  isFree: false,
  childProfiles: [{ id: "c1", display_name: "Amina" }],
  alreadyOwnedBy: [],
} as unknown as React.ComponentProps<typeof PurchasePanel>;

const toggle = () => screen.getByRole("switch", { name: /Give as a gift\?/ });

const giftNote = () => screen.queryByText(/you.ll get a gift code/);

describe("the gift toggle (D-140, D-149)", () => {
  it("is off by default: the ordinary purchase", () => {
    render(<PurchasePanel {...base} startAsGift={false} />);
    expect(toggle()).not.toBeChecked();
    expect(giftNote()).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Amina" })).toBeInTheDocument();
  });

  it("on explains the gift code and takes the child choice away; off restores it", () => {
    render(<PurchasePanel {...base} startAsGift={false} />);
    fireEvent.click(toggle());
    expect(giftNote()).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    fireEvent.click(toggle());
    expect(giftNote()).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Amina" })).toBeInTheDocument();
  });

  it("a gift asks for no recipient address at all", () => {
    render(<PurchasePanel {...base} startAsGift />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="email"]')).toBeNull();
    expect(screen.getByText(/We don.t need their email address/)).toBeInTheDocument();
  });

  it("paying, for a child or as a gift, needs both statements, unticked to begin with (D-152)", () => {
    render(<PurchasePanel {...base} startAsGift />);
    const boxes = [
      screen.getByRole("checkbox", { name: /access to start as soon as/ }),
      screen.getByRole("checkbox", { name: /lose my right to cancel/ }),
    ];
    for (const box of boxes) {
      expect(box).toBeRequired();
      expect(box).not.toBeChecked();
    }
  });

  it("says on and off in words, not by colour alone", () => {
    render(<PurchasePanel {...base} startAsGift={false} />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("a purchaser with no children can still give a gift", () => {
    render(<PurchasePanel {...base} childProfiles={[]} startAsGift={false} />);
    expect(screen.getByText(/Add a child profile first/)).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(giftNote()).toBeInTheDocument();
  });

  it("arriving from Buy a Gift starts on", () => {
    render(<PurchasePanel {...base} startAsGift />);
    expect(toggle()).toBeChecked();
  });

  it("a free mission isn't offered as a gift, whatever the link says", () => {
    render(<PurchasePanel {...base} isFree startAsGift />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(giftNote()).not.toBeInTheDocument();
    // Nothing is paid for, so there is nothing to consent to.
    expect(screen.queryByRole("checkbox", { name: /right to cancel/ })).not.toBeInTheDocument();
  });
});
