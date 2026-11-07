import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The server's part of closure (D-148), run against a scripted database and
 * Storage. Each database function's own behaviour — sibling isolation, what is
 * kept, holds, the restore safeguard — is executed against the real schema in
 * scripts/privacy-regression.sql; here, the order of the steps and what a
 * failure part-way leaves.
 */
const s = vi.hoisted(() => ({
  rpc: vi.fn(),
  remove: vi.fn(),
  removeBucket: [] as string[],
  ban: vi.fn(),
  deleteUser: vi.fn(),
  log: [] as string[],
}));

vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: s.rpc,
    storage: { from: (bucket: string) => ({ remove: (paths: string[]) => { s.removeBucket.push(bucket); return s.remove(paths); } }) },
    auth: { admin: { updateUserById: s.ban, deleteUser: s.deleteUser } },
  }),
}));

import { closeParentAccount, deleteChildProfile, retryOpenClosures } from "../closure";

type Script = Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
function database(script: Script) {
  s.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    s.log.push(name);
    const fn = script[name];
    return fn ? { data: fn(args), error: null } : { data: null, error: null };
  });
}
const begun = (status = "in_progress") => () => [{ outcome: "begun", deletion_id: "del-1", status }];
const FILES = [
  { bucket: "mission-evidence", path: "child-a/m1/photo.jpg" },
  { bucket: "mission-evidence", path: "child-b/m1/notes.pdf" },
];

beforeEach(() => {
  s.rpc.mockReset();
  s.remove.mockReset().mockResolvedValue({ data: [], error: null });
  s.removeBucket = [];
  s.ban.mockReset().mockResolvedValue({ error: null });
  s.deleteUser.mockReset().mockResolvedValue({ error: null });
  s.log = [];
});

describe("closing a parent account", () => {
  it("blocks sign-in, removes every listed file, deletes the data, then the auth user, then records completion", async () => {
    let pending = [...FILES];
    database({
      privacy_begin_closure: begun(),
      privacy_pending_files: () => pending,
      privacy_record_files: (a) => { pending = pending.filter((f) => !(a.p_removed as string[]).includes(f.path)); },
      privacy_finish_closure: () => "data_deleted",
      privacy_complete_closure: () => "completed",
    });
    const result = await closeParentAccount("parent-1", "parent");
    expect(result).toEqual({ state: "completed", deletionId: "del-1" });
    expect(s.ban).toHaveBeenCalledWith("parent-1", { ban_duration: "876000h" });
    expect(s.remove).toHaveBeenCalledWith(FILES.map((f) => f.path));
    expect(s.removeBucket).toEqual(["mission-evidence"]);
    expect(s.deleteUser).toHaveBeenCalledWith("parent-1");
    // Files before data, data before the account, completion last.
    expect(s.log).toEqual([
      "privacy_begin_closure", "privacy_pending_files", "privacy_record_files",
      "privacy_finish_closure", "privacy_complete_closure",
    ]);
  });

  it("a file Storage won't remove stops the closure before any data goes, and is recorded", async () => {
    s.remove.mockResolvedValue({ data: null, error: { name: "StorageApiError" } });
    database({
      privacy_begin_closure: begun(),
      privacy_pending_files: () => FILES,
      privacy_record_files: () => null,
    });
    const result = await closeParentAccount("parent-1", "parent");
    expect(result).toMatchObject({ state: "pending", step: "files" });
    expect(s.log).not.toContain("privacy_finish_closure");
    expect(s.deleteUser).not.toHaveBeenCalled();
    const failure = s.rpc.mock.calls.find(([n]) => n === "privacy_record_failure")![1];
    expect(failure).toMatchObject({ p_deletion: "del-1", p_step: "files", p_error: "storage_StorageApiError" });
    const recorded = s.rpc.mock.calls.find(([n]) => n === "privacy_record_files")![1];
    expect(recorded).toMatchObject({ p_removed: [], p_failed: FILES.map((f) => f.path) });
  });

  it("an auth deletion that fails leaves the request open at that step, for a retry", async () => {
    s.deleteUser.mockResolvedValue({ error: { status: 500 } });
    database({
      privacy_begin_closure: begun(),
      privacy_pending_files: () => [],
      privacy_finish_closure: () => "data_deleted",
    });
    const result = await closeParentAccount("parent-1", "parent");
    expect(result).toMatchObject({ state: "pending", step: "account" });
    expect(s.log).not.toContain("privacy_complete_closure");
    expect(s.rpc).toHaveBeenCalledWith("privacy_record_failure", { p_deletion: "del-1", p_step: "account", p_error: "auth_500" });
  });

  it("a lawful hold stops everything after the account is blocked", async () => {
    database({ privacy_begin_closure: begun("held") });
    expect(await closeParentAccount("parent-1", "parent")).toEqual({ state: "held", deletionId: "del-1" });
    expect(s.ban).toHaveBeenCalled();
    expect(s.remove).not.toHaveBeenCalled();
    expect(s.log).toEqual(["privacy_begin_closure"]);
  });

  it("an administrator's account is refused, and nothing is blocked", async () => {
    database({ privacy_begin_closure: () => [{ outcome: "admin_account", deletion_id: null, status: null }] });
    expect(await closeParentAccount("admin-1", "parent")).toEqual({ state: "refused", reason: "admin_account" });
    expect(s.ban).not.toHaveBeenCalled();
  });

  it("files that keep reappearing are a recorded failure, not a loop", async () => {
    database({
      privacy_begin_closure: begun(),
      privacy_pending_files: () => FILES,
      privacy_record_files: () => null,
      privacy_finish_closure: () => "files_pending",
    });
    const result = await closeParentAccount("parent-1", "parent");
    expect(result).toMatchObject({ state: "pending", step: "files" });
    expect(s.rpc).toHaveBeenCalledWith("privacy_record_failure", expect.objectContaining({ p_error: "files_reappearing" }));
  });
});

describe("deleting one child profile", () => {
  it("is begun for that child of that parent, and never touches the parent's sign-in", async () => {
    database({
      privacy_begin_closure: begun(),
      privacy_pending_files: () => [],
      privacy_finish_closure: () => "completed",
    });
    expect(await deleteChildProfile("parent-1", "child-a", "parent")).toEqual({ state: "completed", deletionId: "del-1" });
    expect(s.rpc).toHaveBeenCalledWith("privacy_begin_closure", {
      p_subject_type: "child_profile", p_subject_id: "child-a", p_parent_id: "parent-1", p_requested_by: "parent",
    });
    expect(s.ban).not.toHaveBeenCalled();
    expect(s.deleteUser).not.toHaveBeenCalled();
  });

  it("someone else's child is refused by the database, and nothing runs", async () => {
    database({ privacy_begin_closure: () => [{ outcome: "not_found", deletion_id: null, status: null }] });
    expect(await deleteChildProfile("parent-1", "child-of-another-family", "parent")).toEqual({ state: "refused", reason: "not_found" });
    expect(s.log).toEqual(["privacy_begin_closure"]);
  });
});

describe("the deletion ledger gate (D-157)", () => {
  it("with a ledger configured but unwritable, deletes nothing and records why", async () => {
    vi.stubEnv("PRIVACY_LEDGER_DIR", "/nonexistent/wla-ledger-test");
    vi.stubEnv("PRIVACY_LEDGER_KEY", Buffer.alloc(32, 7).toString("base64"));
    const failures: unknown[] = [];
    database({
      privacy_begin_closure: begun(),
      privacy_ledger_pending: () => [{ seq: 1, event_id: "e1", event: "closure_requested", payload: { deletion_id: "del-1" }, created_at: "2026-11-07T10:00:00Z" }],
      privacy_record_failure: (a) => { failures.push(a); },
    });
    try {
      const r = await deleteChildProfile("parent-1", "child-a", "parent");
      expect(r).toEqual({ state: "pending", deletionId: "del-1", step: "ledger" });
      expect(failures).toEqual([{ p_deletion: "del-1", p_step: "ledger", p_error: "ledger_unavailable" }]);
      expect(s.log).not.toContain("privacy_pending_files");
      expect(s.log).not.toContain("privacy_finish_closure");
      expect(s.remove).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the scheduled follow-up", () => {
  it("takes every open request as far as it goes, then sweeps orphaned evidence files only", async () => {
    database({
      privacy_open_deletions: () => [
        { id: "del-1", subject_type: "child_profile", parent_id: "p1", step: "files" },
        { id: "del-2", subject_type: "parent_account", parent_id: "p2", step: "data_deleted" },
      ],
      privacy_pending_files: () => [],
      privacy_finish_closure: (a) => (a.p_deletion === "del-1" ? "completed" : "data_deleted"),
      privacy_complete_closure: () => "completed",
      privacy_orphan_files: () => [
        { bucket: "mission-evidence", path: "gone-child/m1/a.jpg" },
        { bucket: "journal-media", path: "never-touched.png" },
      ],
    });
    const r = await retryOpenClosures();
    expect(r).toEqual({ attempted: 2, completed: 2, orphanFilesRemoved: 1, ledgerShipped: 0 });
    expect(s.deleteUser).toHaveBeenCalledExactlyOnceWith("p2");
    // After a restore the auth user returns unblocked: every retry blocks it again.
    expect(s.ban).toHaveBeenCalledExactlyOnceWith("p2", { ban_duration: "876000h" });
    expect(s.remove).toHaveBeenCalledExactlyOnceWith(["gone-child/m1/a.jpg"]);
    expect(s.removeBucket).toEqual(["mission-evidence"]);
  });
});
