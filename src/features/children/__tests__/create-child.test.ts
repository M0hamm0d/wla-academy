import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Adding a child with their access code in the same step (D-108).
 *
 * Behavioural: createChildAction runs against a stubbed parent session and a
 * stubbed issuer, and we inspect what it writes and returns. The issuer itself
 * is the existing "Create a code" path, now shared (features/child-auth).
 */

const inserted: Record<string, unknown>[] = [];
let insertResult: { data: unknown; error: unknown };
const issue = vi.fn();
const reveal = vi.fn();
let existing: unknown = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("createChildAction must not redirect — the code would be lost");
  }),
}));
vi.mock("@/lib/permissions", () => ({
  requireParent: async () => ({
    user: { id: "parent-1" },
    supabase: {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return { select: () => ({ single: async () => insertResult }) };
        },
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing }) }) }) }),
      }),
    },
  }),
  requireOwnedChild: vi.fn(),
}));
vi.mock("@/features/child-auth/issue-code", () => ({
  issueChildAccessCode: (id: string) => issue(id),
  revealChildAccessCode: (id: string) => reveal(id),
}));
vi.mock("@/features/children/active-child", () => ({
  setActiveChild: vi.fn(),
  clearActiveChild: vi.fn(),
  getActiveChildId: vi.fn(),
}));

const { createChildAction } = await import("../actions");

function form(fields: Record<string, string>) {
  // The real form always sends birthYear, as "" when left empty.
  const f = new FormData();
  f.set("birthYear", "");
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  inserted.length = 0;
  issue.mockReset();
  reveal.mockReset();
  existing = null;
  insertResult = { data: { id: "child-9", display_name: "Amina" }, error: null };
});

describe("adding a child with an access code", () => {
  it("creates the child under the session's parent — never one from the form", async () => {
    await createChildAction({}, form({ displayName: "Amina", parent_id: "someone-else", parentId: "x" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].parent_id).toBe("parent-1");
  });

  it("issues the code for the NEW child through the shared server path, and returns it once", async () => {
    issue.mockResolvedValue({ code: "ABCD-2345" });
    const state = await createChildAction({}, form({ displayName: "Amina", accessCode: "on" }));
    expect(issue).toHaveBeenCalledWith("child-9");
    expect(state.created).toEqual({ childId: "child-9", name: "Amina", code: "ABCD-2345", codeFailed: false });
  });

  it("makes no code when the parent chooses not to — a supported state", async () => {
    const state = await createChildAction({}, form({ displayName: "Amina" }));
    expect(issue).not.toHaveBeenCalled();
    expect(state.created?.code).toBeUndefined();
    expect(state.created?.codeFailed).toBe(false);
  });

  it("keeps the child and says so plainly when the code could not be made", async () => {
    issue.mockResolvedValue({ error: "failed" });
    const state = await createChildAction({}, form({ displayName: "Amina", accessCode: "on" }));
    expect(state.created).toMatchObject({ childId: "child-9", codeFailed: true });
    expect(state.created?.code).toBeUndefined();
  });

  it("does not issue a code when the profile was not created", async () => {
    insertResult = { data: null, error: { message: "nope" } };
    const state = await createChildAction({}, form({ displayName: "Amina", accessCode: "on" }));
    expect(issue).not.toHaveBeenCalled();
    expect(state.error).toBeTruthy();
    expect(state.created).toBeUndefined();
  });

  it("rejects invalid input before touching the database", async () => {
    const state = await createChildAction({}, form({ displayName: "", accessCode: "on" }));
    expect(state.fieldErrors?.displayName).toBeTruthy();
    expect(inserted).toHaveLength(0);
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects more than one name before touching the database", async () => {
    const state = await createChildAction(
      {},
      form({ displayName: "Amina Yusuf", accessCode: "on" }),
    );
    expect(state.fieldErrors?.displayName).toBe(
      "Enter one first name or nickname only.",
    );
    expect(inserted).toHaveLength(0);
    expect(issue).not.toHaveBeenCalled();
  });

  it("carries a safe next= (back to a purchase) and drops an unsafe one", async () => {
    const ok = await createChildAction({}, form({ displayName: "Amina", next: "/purchase/mars-bridge" }));
    expect(ok.next).toBe("/purchase/mars-bridge");
    const bad = await createChildAction({}, form({ displayName: "Amina", next: "//evil.example" }));
    expect(bad.next).toBeUndefined();
    const bs = await createChildAction({}, form({ displayName: "Amina", next: "/\\evil.example" }));
    expect(bs.next).toBeUndefined();
  });
});

describe("adding a child is safe to retry (D-144)", () => {
  const KEY = "11111111-2222-4333-8444-555555555555";
  const duplicate = () => {
    insertResult = { data: null, error: { code: "23505" } };
    existing = { id: "child-9", display_name: "Amina" };
  };

  it("records the attempt's key, and the parent comes only from the session", async () => {
    issue.mockResolvedValue({ code: "ABCD-2345", viewable: true });
    await createChildAction({}, form({ displayName: "Amina", creationKey: KEY, parent_id: "someone-else" }));
    expect(inserted[0]).toMatchObject({ parent_id: "parent-1", creation_key: KEY });
  });

  it("a malformed key is ignored rather than trusted", async () => {
    await createChildAction({}, form({ displayName: "Amina", creationKey: "nope" }));
    expect(inserted[0].creation_key).toBeNull();
  });

  it("a retry answers with the profile that exists and generates no code", async () => {
    duplicate();
    reveal.mockResolvedValue({ code: "ABCD-2345" });
    const result = await createChildAction({}, form({ displayName: "Amina", creationKey: KEY, accessCode: "on" }));
    expect(issue).not.toHaveBeenCalled();
    expect(result.created).toMatchObject({ childId: "child-9", alreadyAdded: true, code: "ABCD-2345", viewable: true });
  });

  it("a retry with no viewable code still generates none", async () => {
    duplicate();
    reveal.mockResolvedValue({ error: "no_copy" });
    const result = await createChildAction({}, form({ displayName: "Amina", creationKey: KEY, accessCode: "on" }));
    expect(issue).not.toHaveBeenCalled();
    expect(result.created?.code).toBeUndefined();
    expect(result.created?.alreadyAdded).toBe(true);
  });

  it("a duplicate with no key is an ordinary failure", async () => {
    insertResult = { data: null, error: { code: "23505" } };
    const result = await createChildAction({}, form({ displayName: "Amina" }));
    expect(result.error).toBeTruthy();
  });

  it("passes on whether the new code can be viewed again", async () => {
    issue.mockResolvedValue({ code: "ABCD-2345", viewable: false });
    const result = await createChildAction({}, form({ displayName: "Amina", accessCode: "on" }));
    expect(result.created).toMatchObject({ code: "ABCD-2345", viewable: false });
  });
});
