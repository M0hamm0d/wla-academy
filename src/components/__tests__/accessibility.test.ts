import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repo = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(repo, p), "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "__tests__") out.push(...sourceFiles(rel));
    } else if (/\.tsx$/.test(e.name)) out.push(rel);
  }
  return out;
}

/**
 * WCAG 2.2 AA regressions.
 *
 * These are the structural half. The behavioural half is an audit run against
 * the RENDERED pages — computed styles, real bounding boxes, real accessible
 * names — and it is what found every defect these guards now pin. A source
 * test could not have found any of them; it can stop them coming back.
 */

describe("no nested interactive content", () => {
  it("no <Link> wraps a <Button>", () => {
    /*
     * An anchor containing a button is invalid HTML and announces two controls
     * where there is one thing to do. It also collapses the anchor's hit area
     * to the inline text box while the button inside keeps its 48px — which is
     * how the audit found it, as a 211×22 target around a correct one.
     *
     * `ButtonLink` is the replacement: an anchor that looks like a button.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (/<Link[^>]*>\s*<Button/.test(code(file))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("ButtonLink renders an anchor, not a button", () => {
    const src = code("src/components/ui/button.tsx");
    const fn = src.slice(src.indexOf("export function ButtonLink"));
    expect(fn).toContain("<Link");
    expect(fn).not.toContain("<button");
  });
});

describe("every page has exactly one h1", () => {
  it("a full-page empty/error state can own the page heading", () => {
    /*
     * These states default to h2 because they are usually one region among
     * several — but an early return renders them as the ENTIRE page, and a
     * page whose only heading is an h2 leaves a screen-reader user navigating
     * by heading with no top level to land on.
     */
    const states = code("src/components/system/states.tsx");
    expect(states).toMatch(/as: Heading = "h2"/);
    expect(states).not.toMatch(/<h2 className/);

    // The pages that render a state as their whole <main> pass as="h1".
    for (const page of [
      "src/app/(academy)/academy/my-missions/page.tsx",
      "src/app/(academy)/academy/missions/[missionId]/page.tsx",
      "src/app/(academy)/academy/missions/[missionId]/kit/page.tsx",
    ]) {
      expect(code(page)).toContain('as="h1"');
    }
  });

  it("Active Mission supplies the h1, because several screens have no title", () => {
    /*
     * Every handoff and every reflection is authored with `title: null`, so
     * before this those pages had no h1 anywhere. The mission's name is the
     * page's heading; it is visually hidden because Active Mission is
     * deliberately the quietest surface (UI/UX §17).
     */
    const active = code(
      "src/app/(academy)/academy/missions/[missionId]/active/page.tsx",
    );
    expect(active).toMatch(/<h1 className="sr-only">\{mission\.title\}<\/h1>/);

    // …and the screen's own title steps down to h2 so nothing competes.
    const frame = code("src/components/mission/screens/shared.tsx");
    expect(frame).toMatch(/\{title && <h2/);
    expect(frame).not.toMatch(/\{title && <h1/);
  });

  it("no component renders an h3 without an h2 above it", () => {
    /*
     * Guards the h1 → h3 skips the audit found on My Missions, the Kit and
     * the Trail, where a list item's heading jumped a level.
     *
     * `Dialog.Title` counts as the h2: Radix renders it as one, which is why
     * Mission Control's support items are legitimately h3. Verified in the
     * browser — with the dialog open the page reads
     * H1 Six Names → H2 (screen) → H2 Mission Control → H3 (support item).
     */
    /*
     * `SectionHeader` renders a section's h2. The builder parts listed below
     * are only ever rendered inside a builder section, beneath that h2; the
     * RENDERED order is asserted by builder-workspace.test.tsx ("headings
     * never skip a level"), because a source guard cannot see across files.
     */
    const underBuilderSection = new Set([
      "src/components/admin/flow-map.tsx",
      "src/components/admin/kit-editor.tsx",
      "src/components/admin/print-checklist.tsx",
      "src/components/admin/publish-panel.tsx",
    ]);
    /*
     * Journal studio pieces render beneath the studio's h2 panel and dialog
     * headings ("History", "Comments", "Share a preview", "Review Before
     * Publishing"); the RENDERED order
     * is asserted by journal-studio.test.tsx ("headings never skip a level").
     */
    const underStudioSection = new Set([
      "src/components/journal/studio/history.tsx",
      "src/components/journal/studio/publish-review.tsx",
      "src/components/journal/studio/side-panels.tsx",
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles("src/components")) {
      const src = code(file);
      const hasH2 = /<h2[\s>]/.test(src) || /<Dialog\.Title/.test(src) || /<SectionHeader[\s>]/.test(src);
      if (/<h3[\s>]/.test(src) && !hasH2 && !underBuilderSection.has(file) && !underStudioSection.has(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("touch targets", () => {
  it("no standalone link is rendered as bare text", () => {
    /*
     * WCAG 2.2 adds 2.5.8 Target Size (Minimum) at 24×24; the Academy's own
     * floor is 44px and nearly every link already used it. The audit found the
     * stragglers at 17–23px high.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const src = read(file);
      for (const m of src.matchAll(
        /className="(text-\[length:var\(--text-(?:label|small)\)\] underline[^"]*)"/g,
      )) {
        if (!m[1].includes("min-h-"))
          offenders.push(`${file}: ${m[1].slice(0, 48)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the admin's checkboxes clear the 24px floor", () => {
    const form = code("src/components/admin/mission-form.tsx");
    expect(form).toContain("size-6");
    expect(form).not.toContain("size-5");
  });
});
