import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * SPRINT 2 SECURITY CHECKPOINT
 *
 * One describe block per item the client asked to see evidence for. Run with
 * `npm test` — the output is the checkpoint.
 *
 * These are static guards: they assert that the protections exist and cannot
 * be removed silently. They are NOT a substitute for the live Tech Spec §57
 * penetration tests (cross-child access attempt, manipulated ids, direct
 * storage access), which need a real database and belong in Playwright at
 * Sprint 10.
 */

const root = join(__dirname, "../../..");
const repo = join(root, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sql = (p: string) => readFileSync(join(repo, p), "utf8");

const INIT = "supabase/migrations/20260925220000_init.sql";

// ─────────────────────────────────────────────── 1. parent authentication ──
describe("1. Parent authentication", () => {
  it("requireParent rejects an unauthenticated caller", () => {
    const src = read("lib/permissions/index.ts");
    // `export const requireParent = cache(async () => …` since the per-request
    // dedupe; the property asserted is unchanged.
    const fn = src.slice(src.indexOf("export const requireParent"));
    expect(fn).toContain("supabase.auth.getUser()");
    expect(fn).toContain(
      'throw new AccessError("Not signed in.", "unauthenticated")',
    );
  });

  it("the session is revalidated once per REQUEST, never cached across them", () => {
    /*
     * `cache()` from React memoises for the lifetime of one request only. If
     * this ever became `unstable_cache`, a `revalidate` or a module-level
     * variable, one user's verified session could be served to another.
     */
    const src = read("lib/permissions/index.ts");
    expect(src).toContain('import { cache } from "react"');
    expect(src).not.toMatch(/unstable_cache|revalidate\s*[:=]|globalThis\./);
  });

  it("throws rather than returning null, so a caller cannot forget the check", () => {
    const src = read("lib/permissions/index.ts");
    expect(src).not.toMatch(/export const requireParent[^]*?return null/);
  });

  it("Supabase Auth owns authentication — no bespoke password handling", () => {
    const src = read("features/auth/actions.ts");
    expect(src).toContain("supabase.auth.signInWithPassword");
    expect(src).toContain("supabase.auth.signUp");
    /*
     * No hand-rolled hashing anywhere in the APPLICATION.
     *
     * Comments are stripped first. Child access codes are hashed with bcrypt
     * (D-58) but that happens inside a `security definer` function in the
     * database, and several files explain so in prose. Matching prose made
     * this guard fail on a page that hashes nothing — the opposite of the
     * failure mode these guards usually have, and just as misleading.
     */
    for (const file of sourceFiles(root)) {
      const content = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(content, file).not.toMatch(/\b(bcrypt|scrypt|createHmac\(.*password)/i);
    }
  });
});

// ────────────────────────────────────────────────────── 2. child ownership ──
describe("2. Child ownership", () => {
  it("requireOwnedChild re-asserts parent_id inside the query", () => {
    const src = read("lib/permissions/index.ts");
    const fn = src.slice(
      src.indexOf("export async function requireOwnedChild"),
      src.indexOf("export async function requireEntitledMission"),
    );
    expect(fn).toContain('.eq("id", childId)');
    expect(fn).toContain('.eq("parent_id", user.id)');
    expect(fn).toContain("not_your_child");
  });

  it("every child-scoped mutation validates ownership first", () => {
    const src = read("features/children/actions.ts");
    for (const fn of ["updateChildAction", "deleteChildAction"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const upToNextExport = body.slice(0, body.indexOf("\nexport ", 10));
      expect(upToNextExport, `${fn}`).toContain("requireOwnedChild(childId)");
    }
  });

  it("RLS restricts child_profiles to the owning parent", () => {
    const schema = sql(INIT);
    expect(schema).toContain(
      "alter table child_profiles       enable row level security",
    );
    expect(schema).toContain(
      'create policy "parent manages own children" on child_profiles',
    );
    expect(schema).toContain("using (parent_id = auth.uid())");
  });
});

// ──────────────────────────────────────────────── 3. cross-family isolation ──
describe("3. Cross-family isolation", () => {
  const schema = sql(INIT);

  it("RLS is enabled on every child-scoped table", () => {
    for (const table of [
      "child_profiles",
      "mission_entitlements",
      "mission_progress",
      "mission_state",
      "mission_responses",
      "mission_evidence",
    ]) {
      expect(schema, `${table} must have RLS enabled`).toMatch(
        new RegExp(`alter table ${table}\\s+enable row level security`),
      );
    }
  });

  it("every learner-state policy is scoped by ownership, never left open", () => {
    // owns_child / owns_progress both resolve through auth.uid().
    expect(schema).toContain(
      "where c.id = target_child and c.parent_id = auth.uid()",
    );
    expect(schema).toContain(
      "where p.id = target_progress and c.parent_id = auth.uid()",
    );
    // No policy may be unconditionally true on a child-scoped table.
    const openPolicies = schema
      .split("create policy")
      .slice(1)
      .filter((block) => {
        const head = block.slice(0, block.indexOf(";"));
        return (
          /on (child_profiles|mission_progress|mission_state|mission_responses|mission_evidence|mission_entitlements)/.test(
            head,
          ) && /using \(true\)/.test(head)
        );
      });
    expect(openPolicies).toEqual([]);
  });

  it("private storage buckets are not public", () => {
    expect(schema).toContain(
      "('mission-resources', 'mission-resources', false)",
    );
    expect(schema).toContain(
      "('mission-evidence',  'mission-evidence',  false)",
    );
  });

  it("evidence files are readable only by the owning family", () => {
    expect(schema).toContain(
      'create policy "family reads own evidence files" on storage.objects',
    );
    expect(schema).toContain(
      "owns_child(((storage.foldername(name))[1])::uuid)",
    );
  });
});

// ───────────────────────────────────────────────── 4. active-child context ──
describe("4. Active-child context", () => {
  const activeChild = read("features/children/active-child.ts");

  it("the active child is httpOnly — the browser cannot read or swap it", () => {
    expect(activeChild).toContain("httpOnly: true");
    expect(activeChild).toContain('sameSite: "lax"');
    expect(activeChild).toContain(
      'secure: process.env.NODE_ENV === "production"',
    );
  });

  it("ownership is verified before the cookie is written", () => {
    const fn = activeChild.slice(
      activeChild.indexOf("export async function setActiveChild"),
    );
    const body = fn.slice(0, fn.indexOf("\nexport ", 10));
    const verifyAt = body.indexOf("requireOwnedChild(childId)");
    const writeAt = body.indexOf("store.set(");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(writeAt);
  });

  it("a stored id not belonging to this family is never honoured", () => {
    // resolveActiveChild only accepts a stored id present in the parent's own
    // child list.
    expect(activeChild).toContain("children.some((c) => c.id === stored)");
  });

  it("switching child invalidates the entire Academy context", () => {
    expect(read("features/children/actions.ts")).toContain(
      'revalidatePath("/academy", "layout")',
    );
  });

  it("the cookie carries no authority — every query re-verifies", () => {
    // No route may read the cookie and query on it without going through
    // lib/permissions. getActiveChildId is only consumed by resolveActiveChild
    // and the Academy chrome (display only).
    const consumers = sourceFiles(root).filter((f) =>
      readFileSync(f, "utf8").includes("getActiveChildId("),
    );
    const allowed = [
      "features/children/active-child.ts",
      "features/children/actions.ts",
      // Display only: reads the id to show which child is selected. It never
      // queries on it — every child-scoped query re-verifies ownership.
      "components/academy/academy-chrome.tsx",
      // Same, for the application shell's identity chip and child switcher.
      "components/academy/academy-shell.tsx",
      // resolveAcademyActor reads it to decide WHICH actor is present. The id
      // it returns is an input to the permission chain, never a result of it.
      "features/academy/actor.ts",
    ];
    for (const file of consumers) {
      const rel = relative(root, file).replaceAll("\\", "/");
      expect(
        allowed.some((a) => rel.endsWith(a)),
        `${rel} reads the active-child cookie`,
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────── 5. entitlement checks ──
describe("5. Entitlement checks", () => {
  const src = read("lib/permissions/index.ts");
  const fn = src.slice(
    src.indexOf("export async function requireEntitledMission"),
  );

  it("entitlement is checked against the verified child, not a supplied id", () => {
    expect(fn).toContain('.eq("child_id", child.id)');
    expect(fn).toContain('.eq("mission_id", mission.id)');
    expect(fn).toContain('.eq("status", "active")');
    expect(fn).toContain("not_entitled");
  });

  it("access asks whether, never why — no branch on entitlement source", () => {
    // D-10: free, purchased, gifted and redeemed are identical to the Academy.
    for (const file of sourceFiles(root)) {
      const content = stripComments(readFileSync(file, "utf8"));
      expect(
        content,
        `${relative(root, file).replaceAll("\\", "/")} branches on entitlement source`,
      ).not.toMatch(
        /source\s*===?\s*["'](free|purchase|gift|redeemed|admin)["']/,
      );
    }
  });

  it("an un-entitled mission never renders the mission experience", () => {
    // Tech Spec §26.
    const home = read("app/(academy)/academy/missions/[missionId]/page.tsx");
    expect(home).toContain('error.reason === "not_entitled"');
    expect(home).toContain("notFound()");
  });

  it("the client cannot create a paid entitlement — no insert policy exists", () => {
    const schema = sql(INIT);
    const entitlementPolicies = schema
      .split("create policy")
      .slice(1)
      .map((b) => b.slice(0, b.indexOf(";")))
      .filter((b) => b.includes("on mission_entitlements"));

    expect(entitlementPolicies).toHaveLength(1);
    expect(entitlementPolicies[0]).toContain("for select");
    expect(entitlementPolicies[0]).not.toContain("for insert");
    expect(entitlementPolicies[0]).not.toContain("for all");
  });
});

// ─────────────────────────────────── 6. child-scoped progress/state/evidence ──
describe("6. Child-scoped progress, state and evidence", () => {
  const src = read("lib/permissions/index.ts");

  it("holding a record id is not authorisation", () => {
    for (const fn of ["requireOwnedProgress", "requireOwnedEvidence"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const upToNext = body.slice(0, body.indexOf("\nexport ", 10));
      // Each filters on the VERIFIED child id alongside the supplied record id.
      expect(upToNext, fn).toContain('.eq("child_id", child.id)');
      expect(upToNext, fn).toContain("not_this_childs_record");
    }
  });

  it("mission state is reached only through an owned progress row", () => {
    const body = src.slice(
      src.indexOf("export async function requireOwnedState"),
    );
    // Regex, so neither Prettier's line wrapping nor its trailing comma
    // can break a guard that is about behaviour, not formatting.
    expect(body).toMatch(
      /requireOwnedProgress\(\s*childId,\s*progressId,?\s*\)/,
    );
    expect(body).toContain('.eq("progress_id", progress.id)');
  });

  it("the Mission Trail query is scoped to the verified child", () => {
    const trail = read("features/mission-trail/queries.ts");
    expect(trail).toContain('.eq("child_id", child.id)');
    expect(trail).not.toContain("requireParent()");
  });

  it("progress keys on child_id, never parent_id", () => {
    // Tech Spec §50 — the load-bearing data rule.
    const schema = sql(INIT);
    const progress = schema.slice(
      schema.indexOf("create table mission_progress"),
      schema.indexOf("create table mission_state"),
    );
    expect(progress).toContain(
      "child_id          uuid not null references child_profiles(id)",
    );
    expect(progress).not.toContain("parent_id");
    expect(progress).toContain("unique (child_id, mission_id)");
  });
});

// ────────────────────────────────────────────────────── 7. parent ID derivation ──
describe("7. Parent ID derivation", () => {
  it("parent_id comes from the session, never from the request", () => {
    const src = read("features/children/actions.ts");
    expect(src).toContain("parent_id: user.id");
    expect(src).not.toContain('formData.get("parent_id")');
  });

  it("no code path reads a parent id from client input", () => {
    for (const file of sourceFiles(root)) {
      const content = stripComments(readFileSync(file, "utf8"));
      expect(content).not.toMatch(/formData\.get\(["']parent_?[Ii]d["']\)/);
      expect(content).not.toMatch(/searchParams\.get\(["']parent_?[Ii]d["']\)/);
    }
  });
});

// ──────────────────────────────────────────────────────── 8. redirect validation ──
describe("8. Redirect validation", () => {
  // One guard, lib/safe-next, used by every place a `next` is followed.
  for (const file of [
    "features/auth/actions.ts",
    "app/auth/callback/route.ts",
    "lib/supabase/middleware.ts",
    "features/children/actions.ts",
  ]) {
    it(`${file} validates next= through lib/safe-next`, () => {
      expect(read(file)).toMatch(/from "@\/lib\/safe-next"/);
      expect(read(file)).toMatch(/safeNext(OrNull)?\(/);
    });
  }

  it("sign-up no longer ignores next=, and validates it", () => {
    const signUp = read("features/auth/actions.ts");
    const body = signUp.slice(signUp.indexOf("export async function signUpAction"), signUp.indexOf("export async function signInAction"));
    expect(body).toContain('safeNextOrNull(formData.get("next")');
    expect(body).toContain("encodeURIComponent(destination)");
  });

  it("the guard logic is correct for known attack shapes (the real function)", async () => {
    const { safeNext } = await import("@/lib/safe-next");

    expect(safeNext("//evil.example")).toBe("/academy/my-missions");
    expect(safeNext("https://evil.example")).toBe("/academy/my-missions");
    expect(safeNext("javascript:alert(1)")).toBe("/academy/my-missions");
    // Browsers read /\ as //, so these are protocol-relative in disguise.
    expect(safeNext("/\\evil.example")).toBe("/academy/my-missions");
    expect(safeNext("/\\/evil.example")).toBe("/academy/my-missions");
    // URL parsers strip tab/newline before resolving: /\t/evil → //evil.
    expect(safeNext("/\t/evil.example")).toBe("/academy/my-missions");
    expect(safeNext("/\n/evil.example")).toBe("/academy/my-missions");
    expect(safeNext(null)).toBe("/academy/my-missions");
    expect(safeNext("")).toBe("/academy/my-missions");
    expect(safeNext("/academy/missions/six-names")).toBe("/academy/missions/six-names");
    expect(safeNext("/purchase/mars-bridge")).toBe("/purchase/mars-bridge");
    expect(safeNext("//evil.example", "/account/children")).toBe("/account/children");
  });
});

// ───────────────────────────────────────────── 9. account-enumeration protection ──
describe("9. Account-enumeration protection", () => {
  const src = read("features/auth/actions.ts");

  it("sign-in gives one message for both failure modes", () => {
    expect(src).toContain("That email and password don't match.");
    expect(src).not.toMatch(/no account with that email/i);
    expect(src).not.toMatch(/incorrect password/i);
  });

  it("password reset responds identically whether or not the account exists", () => {
    const fn = src.slice(
      src.indexOf("export async function requestPasswordResetAction"),
    );
    const body = fn.slice(0, fn.indexOf("\nexport ", 10));
    expect(body).toContain("If that email has an account");
    // The Supabase result is deliberately not inspected.
    expect(body).not.toMatch(/if \(error\)/);
  });
});

// ───────────────────────────────────────────────────── 10. sign-out state clearing ──
describe("10. Sign-out state clearing", () => {
  it("clears the Supabase session and the active child", () => {
    const src = read("features/auth/actions.ts");
    const fn = src.slice(src.indexOf("export async function signOutAction"));
    const body = fn.slice(0, fn.indexOf("\nexport ", 10));
    expect(body).toContain("supabase.auth.signOut()");
    expect(body).toContain("clearActiveChild()");
    expect(body).toContain('revalidatePath("/", "layout")');
  });

  it("middleware verifies the session rather than trusting the cookie", () => {
    const mw = read("lib/supabase/middleware.ts");
    expect(mw).toContain("supabase.auth.getUser()");
    expect(mw).not.toContain("supabase.auth.getSession()");
  });

  it("protects the Academy and account routes", () => {
    const mw = read("lib/supabase/middleware.ts");
    expect(mw).toContain('"/academy"');
    expect(mw).toContain('"/account"');
  });
});

// ──────────────────────────────────────────────── 11. destructive child deletion ──
describe("11. Destructive child deletion", () => {
  it("names exactly what is removed", () => {
    const dialog = read("components/profile/remove-child.tsx");
    // The client requires all three to be named explicitly.
    expect(dialog).toMatch(/mission progress/i);
    expect(dialog).toMatch(/responses/i);
    expect(dialog).toMatch(/Mission Trail/);
    expect(dialog).toMatch(/cannot be undone/i);
  });

  it("the database actually cascades what the dialog promises", () => {
    // If this fails, the confirmation copy is lying to the parent.
    const schema = sql(INIT);
    for (const table of [
      "mission_entitlements",
      "mission_progress",
      "mission_evidence",
    ]) {
      const block = schema.slice(schema.indexOf(`create table ${table}`));
      const body = block.slice(0, block.indexOf(");"));
      expect(body, `${table} must cascade from child_profiles`).toMatch(
        /child_id\s+uuid not null references child_profiles\(id\) on delete cascade/,
      );
    }
    // state and responses cascade transitively through progress.
    for (const table of ["mission_state", "mission_responses"]) {
      const block = schema.slice(schema.indexOf(`create table ${table}`));
      const body = block.slice(0, block.indexOf(");"));
      expect(body, `${table} must cascade from mission_progress`).toMatch(
        /progress_id\s+uuid[^,]*references mission_progress\(id\) on delete cascade/,
      );
    }
  });

  it("validates ownership and clears the active child", () => {
    const src = read("features/children/actions.ts");
    const fn = src.slice(
      src.indexOf("export async function deleteChildAction"),
    );
    expect(fn).toContain("requireOwnedChild(childId)");
    // Through the recorded deletion process (D-148), for the VERIFIED child
    // only: the id the database receives is the one requireOwnedChild returned.
    expect(fn).toContain('deleteChildProfile(user.id, child.id, "parent")');
    expect(fn).toContain("clearActiveChild()");
    // Behaviour, sibling isolation and file removal are executed against the
    // real schema by scripts/privacy-regression.sql.
  });

  it("requires explicit confirmation — no one-click delete", () => {
    const dialog = read("components/profile/remove-child.tsx");
    expect(dialog).toContain("Dialog.Root");
    expect(dialog).toContain("Keep it");
  });
});

// ─────────────────────────────────────────────────────────────────── helpers ──
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !full.includes("__tests__"))
      out.push(full);
  }
  return out;
}
