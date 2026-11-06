import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * STRUCTURAL GUARDS
 *
 * These assert the authorisation rules that are easy to erode by accident.
 * They read source rather than run queries, because the failure mode being
 * guarded against is "someone bypassed the layer", which a mocked query test
 * would not catch.
 *
 * Tech Spec §57 also requires a live cross-child access attempt against a real
 * database — that belongs in the Playwright suite (Sprint 10) and is not a
 * substitute for these.
 */

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const CHILD_SCOPED_TABLES = [
  "child_profiles",
  "mission_entitlements",
  "mission_progress",
  "mission_state",
  "mission_responses",
  "mission_evidence",
];

describe("child-scoped data access", () => {
  it("only lib/permissions and feature queries touch child-scoped tables", () => {
    // Feature query modules are allowed because each one calls into
    // lib/permissions first; everything else must go through them.
    const allowed = [
      "lib/permissions/index.ts",
      "features/children/queries.ts",
      "features/children/actions.ts", // mutations; each calls permissions first
      "features/missions/queries.ts",
      "features/mission-trail/queries.ts",
      "features/mission-engine/persistence.ts",
      "features/commerce/queries.ts",
      "features/commerce/checkout.ts", // calls requireOwnedChild first
      "app/api/webhooks/stripe/route.ts", // service-role, post-verification
    ];

    const offenders: string[] = [];
    const files = listSourceFiles(root);

    for (const file of files) {
      const rel = relative(root, file).replaceAll("\\", "/");
      if (allowed.some((a) => rel.endsWith(a))) continue;
      if (rel.includes("__tests__")) continue;

      const content = readFileSync(file, "utf8");
      for (const table of CHILD_SCOPED_TABLES) {
        if (content.includes(`.from("${table}")`)) {
          offenders.push(`${rel} queries ${table} directly`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every ownership check re-asserts the boundary inside the query", () => {
    const src = read("lib/permissions/index.ts");

    // requireOwnedChild must filter on parent_id, not just id.
    expect(src).toContain('.eq("parent_id", user.id)');
    // Step-4 validators must filter on the verified child id.
    expect(
      src.match(/\.eq\("child_id", child\.id\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  it("the service-role client is server-only", () => {
    expect(read("lib/supabase/admin.ts")).toContain('import "server-only"');
    expect(read("lib/permissions/index.ts")).toContain('import "server-only"');
    expect(read("features/children/active-child.ts")).toContain(
      'import "server-only"',
    );
  });

  it("switching child invalidates the whole Academy context", () => {
    const src = read("features/children/actions.ts");
    expect(src).toContain('revalidatePath("/academy", "layout")');
  });
});

describe("mission engine stays generic", () => {
  it("no route or component branches on a specific mission", () => {
    const offenders: string[] = [];
    // Catches `missionId === "six-names"`, `slug === 'mars'`, etc.
    const hardCoded = /\b(missionId|slug|mission_id)\s*===?\s*["'][a-z-]+["']/i;

    for (const file of listSourceFiles(root)) {
      if (file.includes("__tests__")) continue;
      // Strip comments first — several files legitimately quote this pattern
      // in order to forbid it.
      const content = stripComments(readFileSync(file, "utf8"));
      if (hardCoded.test(content)) {
        offenders.push(file.replace(root + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the screen registry is keyed by type, not by mission", () => {
    const src = read("features/mission-engine/registry.ts");
    expect(src).toContain("Record<ScreenType, ScreenComponent>");
  });
});

describe("currency is never hard-coded in UI", () => {
  it("formatPrice requires a currency argument", () => {
    const src = read("lib/utils.ts");
    expect(src).toMatch(
      /formatPrice\(\s*amountInMinorUnits: number,\s*currency: string/,
    );
  });

  it("no component hard-codes a currency code or symbol", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(root, "components"))) {
      const content = readFileSync(file, "utf8");
      if (/currency:\s*["'][A-Z]{3}["']/.test(content)) {
        offenders.push(file.replace(root + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Remove block and line comments so documentation cannot trip a guard. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}
