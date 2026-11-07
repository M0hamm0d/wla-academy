import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const createChild = vi.fn();
const acquire = vi.fn();
const redeem = vi.fn();
vi.mock("@/features/children/actions", () => ({
  createChildAction: (...a: unknown[]) => createChild(...a),
  updateChildAction: vi.fn(),
}));
vi.mock("@/features/commerce/actions", () => ({
  acquireMissionAction: (...a: unknown[]) => acquire(...a),
}));
vi.mock("@/features/gifts/actions", () => ({
  redeemGiftAction: (...a: unknown[]) => redeem(...a),
  confirmGiftEmailAction: vi.fn(),
  confirmGiftCodeAction: vi.fn(),
  requestGiftCodeAction: vi.fn(),
  giftMissionAction: vi.fn(),
}));

import { PurchaseForm } from "../purchase-form";
import { RedeemGiftForm } from "../redeem-forms";
import type { ChildProfileRow } from "@/types/database";

const amina = { id: "c1", display_name: "Amina" } as ChildProfileRow;
const CODE = "ABCD-2345";
const base = {
  missionSlug: "six-names",
  missionTitle: "Six Names",
  priceLabel: "£12.00",
  isFree: false,
  childProfiles: [amina],
  alreadyOwnedBy: [] as string[],
};
const createdBilal = (over = {}) => ({
  created: { childId: "c2", name: "Bilal", code: CODE, viewable: true, ...over },
});
const pay = () => screen.queryByRole("button", { name: /Continue to payment/ });
/** Both checkout statements (D-152); payment can't be submitted without them. */
const agree = () => {
  fireEvent.click(screen.getByRole("checkbox", { name: /access to start as soon as/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /lose my right to cancel/ }));
};

async function addBilal() {
  fireEvent.click(screen.getByRole("button", { name: "Add a new child" }));
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Bilal" } });
  fireEvent.click(screen.getByRole("button", { name: "Add this child" }));
  await screen.findByText(/Bilal has been added and selected/);
}

beforeEach(() => {
  createChild.mockResolvedValue(createdBilal());
  acquire.mockResolvedValue({});
  redeem.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("choosing or adding a child while buying (D-144)", () => {
  it("shows existing children and the option to add one; nothing is created until asked", () => {
    render(<PurchaseForm {...base} />);
    expect(screen.getByRole("radio", { name: "Amina" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Add a new child" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument();
    expect(createChild).not.toHaveBeenCalled();
  });

  it("selecting an existing child submits that child", async () => {
    render(<PurchaseForm {...base} childProfiles={[amina, { id: "c3", display_name: "Sara" } as ChildProfileRow]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Sara" }));
    agree();
    fireEvent.click(pay()!);
    await waitFor(() => expect(acquire).toHaveBeenCalled());
    expect((acquire.mock.calls[0][2] as FormData).get("childId")).toBe("c3");
  });

  it("revealing the form stops payment until it is finished or cancelled", () => {
    render(<PurchaseForm {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a new child" }));
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(pay()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(pay()).toBeInTheDocument();
    expect(createChild).not.toHaveBeenCalled();
  });

  it("the new child is selected automatically, with the code on screen before payment", async () => {
    render(<PurchaseForm {...base} />);
    await addBilal();
    expect(screen.getByRole("radio", { name: "Bilal" })).toBeChecked();
    expect(screen.getByTestId("child-code")).toHaveTextContent(CODE);
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    agree();
    fireEvent.click(pay()!);
    await waitFor(() => expect(acquire).toHaveBeenCalled());
    expect(acquire.mock.calls[0][0]).toBe("six-names");
    expect((acquire.mock.calls[0][2] as FormData).get("childId")).toBe("c2");
  });

  it("if the code can't be shown again, payment waits until the parent says it's saved", async () => {
    createChild.mockResolvedValue(createdBilal({ viewable: false }));
    render(<PurchaseForm {...base} />);
    await addBilal();
    expect(screen.getByTestId("child-code")).toHaveTextContent(CODE);
    expect(pay()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /saved this code/ }));
    expect(pay()).toBeInTheDocument();
  });

  it("a retry of one attempt sends the same key; a validation error doesn't change it", async () => {
    createChild.mockResolvedValueOnce({ error: "We couldn't add that profile." }).mockResolvedValue(createdBilal());
    render(<PurchaseForm {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a new child" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Bilal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add this child" }));
    await waitFor(() => expect(createChild).toHaveBeenCalledTimes(1));
    await screen.findByText(/couldn't add/);
    fireEvent.click(screen.getByRole("button", { name: "Add this child" }));
    await waitFor(() => expect(createChild).toHaveBeenCalledTimes(2));
    const key = (n: number) => (createChild.mock.calls[n][1] as FormData).get("creationKey");
    expect(key(0)).toBeTruthy();
    expect(key(1)).toBe(key(0));
  });

  it("a validation error keeps the form open and selects nobody new", async () => {
    createChild.mockResolvedValue({ fieldErrors: { displayName: "Enter a name." } });
    render(<PurchaseForm {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a new child" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add this child" }));
    await screen.findByText("Enter a name.");
    expect(screen.getByRole("radio", { name: "Amina" })).toBeChecked();
    expect(pay()).toBeNull();
  });

  it("a parent with no children gets the form straight away, still created only on submit", async () => {
    render(<PurchaseForm {...base} childProfiles={[]} />);
    expect(screen.getByText(/Add a child profile first/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(createChild).not.toHaveBeenCalled();
    expect(pay()).toBeNull();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Bilal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add this child" }));
    await waitFor(() => expect(pay()).toBeInTheDocument());
  });

  it("when everyone already has it, a new child is still possible", async () => {
    render(<PurchaseForm {...base} alreadyOwnedBy={["c1"]} />);
    expect(screen.getByText(/Everyone on this account already has Six Names/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to My Missions" })).toBeInTheDocument();
    expect(pay()).toBeNull();
    await addBilal();
    expect(pay()).toBeInTheDocument();
  });

  it("no child the server has refreshed in is listed twice", async () => {
    const { rerender } = render(<PurchaseForm {...base} />);
    await addBilal();
    rerender(<PurchaseForm {...base} childProfiles={[amina, { id: "c2", display_name: "Bilal" } as ChildProfileRow]} />);
    expect(screen.getAllByRole("radio", { name: "Bilal" })).toHaveLength(1);
  });
});

describe("the same picker when redeeming a gift (D-144)", () => {
  const gift = { missionTitle: "Six Names", childProfiles: [amina], alreadyOwnedBy: [] as string[] };

  it("an existing child redeems", async () => {
    render(<RedeemGiftForm {...gift} />);
    fireEvent.click(screen.getByRole("button", { name: "Redeem this gift" }));
    await waitFor(() => expect(redeem).toHaveBeenCalled());
    expect((redeem.mock.calls[0][1] as FormData).get("childId")).toBe("c1");
  });

  it("a new child is added here and redeems without leaving", async () => {
    render(<RedeemGiftForm {...gift} />);
    await addBilal();
    fireEvent.click(screen.getByRole("button", { name: "Redeem this gift" }));
    await waitFor(() => expect(redeem).toHaveBeenCalled());
    expect((redeem.mock.calls[0][1] as FormData).get("childId")).toBe("c2");
  });

  it("a recipient with no children starts with the form", () => {
    render(<RedeemGiftForm {...gift} childProfiles={[]} />);
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Redeem this gift" })).toBeNull();
  });

  it("everyone having it says the gift is unused, and offers a new child", () => {
    render(<RedeemGiftForm {...gift} alreadyOwnedBy={["c1"]} />);
    expect(screen.getByText(/The gift hasn’t been used/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a new child" })).toBeInTheDocument();
  });
});
