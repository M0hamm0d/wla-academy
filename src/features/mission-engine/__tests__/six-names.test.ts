import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  applyInteraction,
  emptyMissionState,
  isMissionComplete,
  parseScreenConfig,
  resolveNextScreen,
  type CompletionRule,
  type MissionScreen,
  type MissionStateData,
} from "../index";
import { buildModel } from "../definition";
import { EngineRefusal, step } from "../runtime";
import { projectScreen } from "../projection";

/**
 * SIX NAMES — conformance to the ACADEMY BUILD BRIEF of 2026-09-27.
 *
 * Supersedes the v0.2 conformance suite. The mission changed shape: the
 * Concern selection is no longer collected, the trackers became confirmations
 * rather than inputs, and both text responses are gone.
 *
 * Two kinds of assertion, deliberately kept apart:
 *
 *   1. BEHAVIOUR — the real reducer and real navigation are driven over the
 *      graph below, which mirrors the v2 seed. These prove the engine does the
 *      right thing.
 *
 *   2. AUTHORED CONTENT — asserted against the seed FILE. These prove the copy
 *      the Brief marks "Show exactly" is present verbatim and that the wiring
 *      in the graph below has not drifted from the seed.
 *
 * Neither proves the database enforces anything. That was established by
 * executing the migrations and seeds against a real PostgreSQL cluster — see
 * docs/LIVE-VALIDATION.md.
 */

const repo = join(__dirname, "../../../..");
const seed = readFileSync(
  join(repo, "supabase/seed/six_names_v2_screens.sql"),
  "utf8",
);
const access = readFileSync(
  join(repo, "supabase/migrations/20260925220600_screen_access.sql"),
  "utf8",
);
const withholdNext = readFileSync(
  join(repo, "supabase/migrations/20260927100100_withhold_unused_next_key.sql"),
  "utf8",
);
const runtimeSrc = readFileSync(join(__dirname, "../runtime.ts"), "utf8");
const persistence = readFileSync(
  join(repo, "src/features/mission-engine/persistence.ts"),
  "utf8",
);

/** Seed source with SQL comments stripped — a guard must not pass off prose. */
const seedCode = seed.replace(/^\s*--.*$/gm, "");

const screen = (
  key: string,
  type: MissionScreen["type"],
  sequence: number,
  configuration: unknown = {},
): MissionScreen => ({
  screenKey: key,
  type,
  title: null,
  body: null,
  sequence,
  configuration,
});

// ─────────────────────────────────────────────────────── the authored graph ──

const D1 = [
  {
    id: "ask_about_list",
    label: "Ask about the list",
    description: "Go to the office and ask what the list is for.",
    next: "consequence1_ask",
  },
  {
    id: "stop_claim_spreading",
    label: "Stop the claim spreading",
    description:
      "Tell nearby children nobody knows what the list means yet. Ask them not to repeat the claim as though it were true.",
    next: "consequence1_stop",
  },
];

const D2 = [
  {
    id: "ask_everyone_pause",
    label: "Ask everyone to pause",
    description:
      "Ask nearby groups to stop treating the list as proof until someone explains it.",
    next: "consequence2_pause",
  },
  {
    id: "share_the_role",
    label: "Continue, but share the role",
    description:
      "Continue the project task, but share Noor’s role with someone else until the list is explained.",
    next: "consequence2_share",
  },
  {
    id: "noor_steps_away",
    label: "Suggest Noor steps away",
    description:
      "Suggest that Noor temporarily steps away from the project role until the list is explained.",
    next: "consequence2_step_away",
  },
];

const JUDGEMENTS = [
  {
    id: "stand_by_both",
    label: "I stand by both decisions.",
    next: "reflection_both",
  },
  {
    id: "reconsider_one",
    label: "I would reconsider Decision 1.",
    next: "reflection_d1",
  },
  {
    id: "reconsider_two",
    label: "I would reconsider Decision 2.",
    next: "reflection_d2",
  },
];

const track = (
  key: string,
  seq: number,
  next: string,
  spread: string,
  support: string,
  clarity: string,
): MissionScreen =>
  screen(key, "tracker_confirmation", seq, {
    rows: [
      { label: "Spread", position: spread },
      { label: "Support", position: support },
      { label: "Clarity", position: clarity },
    ],
    canonicalTracker: { spread, support, clarity },
    next,
  });

const graph: MissionScreen[] = [
  screen("the_list", "content", 10, {
    next: "seen_said_unknown",
    listObject: [
      { text: "Noor", mark: "none" },
      { text: "Alex", mark: "none" },
      { text: "Sam", mark: "none" },
      { text: "Mika", mark: "none" },
      { text: "Ari", mark: "none" },
      { text: "Remy", mark: "none" },
    ],
  }),
  screen("seen_said_unknown", "sort_items", 20, {
    next: "handoff_step3",
    prompt:
      "Is this something you have seen, something someone said, or something nobody has told you yet?",
    categories: [
      { id: "seen", label: "Seen" },
      { id: "said", label: "Said" },
      { id: "unknown", label: "Unknown" },
    ],
    items: [
      {
        id: "i1",
        text: "Six names are written on the paper.",
        classification: "seen",
      },
      { id: "i2", text: "The paper has no title.", classification: "seen" },
      {
        id: "i3",
        text: "The list is on the board outside the head teacher’s office.",
        classification: "seen",
      },
      {
        id: "i4",
        text: "Someone says the list is about copying.",
        classification: "said",
      },
      { id: "i5", text: "Who wrote the list?", classification: "unknown" },
      {
        id: "i6",
        text: "Why are these six names there?",
        classification: "unknown",
      },
      {
        id: "i7",
        text: "Is the copying claim true?",
        classification: "unknown",
      },
    ],
    missionControl: [
      { title: "I’m not sure what I know.", body: "Read the item again." },
    ],
  }),
  screen("handoff_step3", "handoff", 30, {
    location: "Complete Step 3 — Choose what matters most.",
    steps: ["Look at the four Concern cards."],
    returnInstruction: "Stuck? Open Mission Control.",
    returnLabel: "Continue to Decision 1",
    next: "decision1",
    missionControl: [
      { title: "I can’t choose a concern.", body: "Look at all four cards." },
    ],
  }),
  screen("decision1", "choice", 40, {
    prompt: "What do you do?",
    options: D1,
    locksOnConfirm: true,
  }),
  screen("consequence1_ask", "content", 50, { next: "tracker1_ask" }),
  screen("consequence1_stop", "content", 51, { next: "tracker1_stop" }),
  track(
    "tracker1_ask",
    60,
    "changed_list",
    "Groups",
    "Some support",
    "Guesswork",
  ),
  track(
    "tracker1_stop",
    61,
    "changed_list",
    "Groups",
    "Clearly supported",
    "Guesswork",
  ),
  screen("changed_list", "content", 70, {
    next: "ssu_revisit",
    listObject: [
      { text: "Noor", mark: "none" },
      { text: "Alex", mark: "none" },
      { text: "Sam", mark: "none" },
      { text: "Mika", mark: "struck" },
      { text: "Ari", mark: "none" },
      { text: "Remy", mark: "none" },
      { text: "Jude", mark: "added" },
      { text: "Zain", mark: "added" },
    ],
  }),
  screen("ssu_revisit", "content", 80, {
    next: "handoff_step7",
    reflectionPrompts: [
      "What has visibly changed?",
      "What is still only said?",
      "What remains unknown?",
    ],
  }),
  screen("handoff_step7", "handoff", 90, {
    location: "Complete Step 7 — Choose what matters now.",
    steps: ["Look again at the four Concern cards."],
    returnInstruction: "Stuck? Open Mission Control.",
    returnLabel: "Continue to Decision 2",
    next: "decision2",
    missionControl: [
      {
        title: "I’m not sure what matters now.",
        body: "Start with what changed.",
      },
    ],
  }),
  screen("decision2", "choice", 100, {
    prompt: "What do you do now?",
    options: D2,
    locksOnConfirm: true,
  }),
  screen("consequence2_pause", "content", 110, { next: "tracker2_pause" }),
  screen("consequence2_share", "content", 111, { next: "tracker2_share" }),
  screen("consequence2_step_away", "content", 112, {
    next: "tracker2_step_away",
  }),
  track(
    "tracker2_pause",
    120,
    "stopping_point",
    "Nearly everyone",
    "Clearly supported",
    "Guesswork",
  ),
  track(
    "tracker2_share",
    121,
    "stopping_point",
    "Nearly everyone",
    "Some support",
    "Guesswork",
  ),
  track(
    "tracker2_step_away",
    122,
    "stopping_point",
    "Nearly everyone",
    "Alone",
    "Guesswork",
  ),
  screen("stopping_point", "content", 130, {
    next: "evidence",
    actionLabel: "Continue",
    secondaryAction: "Pause Mission",
  }),
  screen("evidence", "reveal", 140, {
    concealedPrompt: "Open Evidence",
    revealLabel: "Open Evidence",
    revealedTitle: "PROJECT EQUIPMENT CHECK",
    revealedBody:
      "The names belonged to pupils whose team-equipment records still needed checking.",
    reflectionPrompts: [
      "What does this evidence explain?",
      "What does it not undo?",
    ],
    condition: { type: "child_action" },
    canonicalTracker: { clarity: "Purpose clear" },
    next: "handoff_step11",
  }),
  screen("handoff_step11", "handoff", 150, {
    location: "Complete Step 11 — Decide what you stand by.",
    steps: ["Choose the Judgement card that best matches your view."],
    returnInstruction: "Stuck? Open Mission Control.",
    returnLabel: "Continue to Judgement",
    next: "judgement",
    missionControl: [
      {
        title: "I’m not sure what I stand by.",
        body: "Take the two decisions one at a time.",
      },
    ],
  }),
  screen("judgement", "choice", 160, {
    prompt: "Select the Judgement card you placed on your Case Board.",
    options: JUDGEMENTS,
    locksOnConfirm: true,
  }),
  screen("reflection_both", "reflection", 170, {
    prompts: ["Why do you still stand by both decisions?"],
    next: "final_judgement",
  }),
  screen("reflection_d1", "reflection", 171, {
    unusedFrom: "decision1",
    unusedOptions: D1.map((o) => ({ id: o.id, label: o.label })),
    selectable: false,
    prompts: [
      "What might that choice have helped?",
      "What might still have been difficult?",
    ],
    next: "final_judgement",
  }),
  screen("reflection_d2", "reflection", 172, {
    unusedFrom: "decision2",
    unusedPrompt: "Which one would you now consider?",
    unusedOptions: D2.map((o) => ({ id: o.id, label: o.label })),
    selectable: true,
    prompts: [
      "What might that choice have helped?",
      "What might still have been difficult?",
    ],
    next: "final_judgement",
  }),
  screen("final_judgement", "content", 180, {
    next: "complete",
    actionLabel: "Complete Mission",
  }),
  screen("complete", "completion", 190, {
    message:
      "Your Six Names Case Board and What’s Changing? tracker are your Mission Trail.",
    trailEntries: [
      {
        type: "physical",
        title: "Six Names Case Board",
        description: "Your completed Case Board.",
      },
      {
        type: "physical",
        title: "What’s Changing? tracker",
        description: "Your tracker.",
      },
      {
        type: "physical",
        title: "Final Judgement card",
        description: "Your completed card.",
      },
    ],
  }),
];

const byKey = new Map(graph.map((s) => [s.screenKey, s]));
const ordered = [...graph].sort((a, b) => a.sequence - b.sequence);
const nextSequenceKey = (key: string): string | null => {
  const i = ordered.findIndex((s) => s.screenKey === key);
  return ordered[i + 1]?.screenKey ?? null;
};

const COMPLETION_RULE: CompletionRule = {
  type: "conditions",
  conditions: [
    { kind: "choice_exists", screenKey: "decision1" },
    { kind: "choice_exists", screenKey: "decision2" },
    { kind: "screen_visited", screenKey: "evidence" },
    { kind: "choice_exists", screenKey: "judgement" },
    { kind: "screen_visited", screenKey: "final_judgement" },
  ],
};

/**
 * Play the mission with the REAL reducer and REAL navigation.
 *
 * Every screen is entered, acted on, and left by asking navigation where to
 * go — exactly as the runner does. Nothing here knows the route in advance.
 */
function play(d1: string, d2: string, judgement: string) {
  let state: MissionStateData = emptyMissionState;
  const path: string[] = [];
  let key: string | null = "the_list";
  let completedAt: string | null = null;

  for (let guard = 0; key && guard < 60; guard++) {
    const current: MissionScreen = byKey.get(key)!;
    path.push(key);

    if (current.type === "choice") {
      const pick =
        key === "decision1" ? d1 : key === "decision2" ? d2 : judgement;
      state = applyInteraction(state, {
        kind: "choice",
        screenKey: key,
        optionId: pick,
      });
    } else if (current.type === "reveal") {
      state = applyInteraction(state, { kind: "reveal", screenKey: key });
    } else if (current.type === "handoff") {
      state = applyInteraction(state, { kind: "handoff", screenKey: key });
    } else {
      state = applyInteraction(state, { kind: "visit", screenKey: key });
    }

    if (!completedAt && isMissionComplete(COMPLETION_RULE, state)) {
      completedAt = key;
    }
    if (current.type === "completion") break;

    key = resolveNextScreen(current, nextSequenceKey(key), state);
  }

  return { path, state, completedAt };
}

/**
 * The same routes, played through the FOUNDATION runtime (runtime.ts) — the
 * code the server and Learner Preview actually run since D-80. A reveal now
 * stays on its screen (D-69), so Evidence takes two interactions: open, then
 * Continue. Everything else must match the legacy reducer exactly.
 */
function playRuntime(d1: string, d2: string, judgement: string) {
  const model = buildModel({ definition: {}, screens: graph, completionRule: COMPLETION_RULE });
  let state: MissionStateData = emptyMissionState;
  const path: string[] = [];
  let key: string | null = "the_list";
  let completed = false;
  const now = new Date("2026-10-04T12:00:00Z");
  for (let guard = 0; key && guard < 80 && !completed; guard++) {
    const current = byKey.get(key)!;
    if (path[path.length - 1] !== key) path.push(key);
    const i =
      current.type === "choice"
        ? { kind: "choice" as const, screenKey: key, optionId: key === "decision1" ? d1 : key === "decision2" ? d2 : judgement }
        : current.type === "reveal" && !state.revealed.includes(key)
          ? { kind: "reveal" as const, screenKey: key }
          : current.type === "handoff" || current.type === "prepare"
            ? { kind: "handoff" as const, screenKey: key }
            : { kind: "visit" as const, screenKey: key };
    const r = step(model, state, key, i, now);
    if (!r.ok) throw new Error(`refused on ${key}: ${r.failure.code}`);
    state = r.state;
    completed = r.completed;
    key = r.nextScreenKey;
  }
  return { path, state, completed, model };
}

const ALL_C1 = ["consequence1_ask", "consequence1_stop"];
const ALL_T1 = ["tracker1_ask", "tracker1_stop"];
const ALL_C2 = [
  "consequence2_pause",
  "consequence2_share",
  "consequence2_step_away",
];
const ALL_T2 = ["tracker2_pause", "tracker2_share", "tracker2_step_away"];
const ALL_REFLECTIONS = ["reflection_both", "reflection_d1", "reflection_d2"];

const EXPECTED = {
  ask_about_list: { consequence: "consequence1_ask", tracker: "tracker1_ask" },
  stop_claim_spreading: {
    consequence: "consequence1_stop",
    tracker: "tracker1_stop",
  },
  ask_everyone_pause: {
    consequence: "consequence2_pause",
    tracker: "tracker2_pause",
  },
  share_the_role: {
    consequence: "consequence2_share",
    tracker: "tracker2_share",
  },
  noor_steps_away: {
    consequence: "consequence2_step_away",
    tracker: "tracker2_step_away",
  },
} as const;

// ───────────────────────────────────────────────────────── the six routes ──

/** Every .ts/.tsx file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const abs = join(repo, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(join(repo, p));
  }
  return out;
}

describe("the six valid routes", () => {
  const routes = D1.flatMap((a) => D2.map((b) => [a.id, b.id] as const));

  it("there are exactly six", () => {
    expect(routes).toHaveLength(6);
  });

  it.each(routes)("%s → %s reaches completion", (d1, d2) => {
    const { path, completedAt } = play(d1, d2, "stand_by_both");
    expect(path.at(-1)).toBe("complete");
    // Completion is reached ON the Final Judgement screen, never before it.
    expect(completedAt).toBe("final_judgement");
  });

  it.each(routes)("%s → %s reveals only its own consequences", (d1, d2) => {
    const { path } = play(d1, d2, "stand_by_both");
    const e1 = EXPECTED[d1 as keyof typeof EXPECTED];
    const e2 = EXPECTED[d2 as keyof typeof EXPECTED];

    expect(path).toContain(e1.consequence);
    expect(path).toContain(e2.consequence);
    for (const other of [...ALL_C1, ...ALL_C2]) {
      if (other !== e1.consequence && other !== e2.consequence) {
        expect(path).not.toContain(other);
      }
    }
  });

  it.each(routes)("%s → %s confirms only its own tracker state", (d1, d2) => {
    const { path } = play(d1, d2, "stand_by_both");
    const e1 = EXPECTED[d1 as keyof typeof EXPECTED];
    const e2 = EXPECTED[d2 as keyof typeof EXPECTED];

    expect(path).toContain(e1.tracker);
    expect(path).toContain(e2.tracker);
    for (const other of [...ALL_T1, ...ALL_T2]) {
      if (other !== e1.tracker && other !== e2.tracker) {
        expect(path).not.toContain(other);
      }
    }
  });

  it.each(routes)("%s → %s orders the stages correctly", (d1, d2) => {
    const { path } = play(d1, d2, "stand_by_both");
    const at = (k: string) => path.indexOf(k);

    expect(at("the_list")).toBeLessThan(at("seen_said_unknown"));
    expect(at("seen_said_unknown")).toBeLessThan(at("decision1"));
    // The Changed List lands after the first consequence and before Decision 2.
    expect(at("changed_list")).toBeGreaterThan(at("decision1"));
    expect(at("changed_list")).toBeLessThan(at("decision2"));
    // Evidence stays concealed until after Decision 2 (Brief, BRANCH QA).
    expect(at("evidence")).toBeGreaterThan(at("decision2"));
    expect(at("evidence")).toBeLessThan(at("judgement"));
    expect(at("judgement")).toBeLessThan(at("final_judgement"));
  });
});

// ──────────────────────────────────────────── the canonical tracker states ──

describe("canonical tracker states", () => {
  const rowsOf = (key: string) =>
    parseScreenConfig("tracker_confirmation", byKey.get(key)!.configuration)
      .rows;

  it("Decision 1 — Ask about the list", () => {
    expect(rowsOf("tracker1_ask")).toEqual([
      { label: "Spread", position: "Groups" },
      { label: "Support", position: "Some support" },
      { label: "Clarity", position: "Guesswork" },
    ]);
  });

  it("Decision 1 — Stop the claim spreading", () => {
    expect(rowsOf("tracker1_stop")).toEqual([
      { label: "Spread", position: "Groups" },
      { label: "Support", position: "Clearly supported" },
      { label: "Clarity", position: "Guesswork" },
    ]);
  });

  it("Decision 2 — Ask everyone to pause", () => {
    expect(rowsOf("tracker2_pause")).toEqual([
      { label: "Spread", position: "Nearly everyone" },
      { label: "Support", position: "Clearly supported" },
      { label: "Clarity", position: "Guesswork" },
    ]);
  });

  it("Decision 2 — Continue, but share the role", () => {
    expect(rowsOf("tracker2_share")).toEqual([
      { label: "Spread", position: "Nearly everyone" },
      { label: "Support", position: "Some support" },
      { label: "Clarity", position: "Guesswork" },
    ]);
  });

  it("Decision 2 — Suggest Noor steps away", () => {
    expect(rowsOf("tracker2_step_away")).toEqual([
      { label: "Spread", position: "Nearly everyone" },
      { label: "Support", position: "Alone" },
      { label: "Clarity", position: "Guesswork" },
    ]);
  });

  it("Clarity stays Guesswork until Evidence, on every branch", () => {
    for (const key of [...ALL_T1, ...ALL_T2]) {
      const clarity = rowsOf(key).find((r) => r.label === "Clarity");
      expect(clarity?.position).toBe("Guesswork");
    }
  });

  it("Evidence changes ONLY Clarity", () => {
    const config = parseScreenConfig(
      "reveal",
      byKey.get("evidence")!.configuration,
    );
    expect(config.canonicalTracker).toEqual({ clarity: "Purpose clear" });
    // Nothing about Spread or Support — they are left exactly as the branch
    // left them, which is what "new facts do not erase what happened" means.
    expect(Object.keys(config.canonicalTracker)).toEqual(["clarity"]);
  });

  it("the canonical state is applied by the SERVER, never sent by the browser", () => {
    /*
     * The function moved to navigation.ts so the admin Preview can apply the
     * same one (a preview showing different tracker values than the mission it
     * previews would be worse than no preview). That does not weaken this
     * property: the security claim is that the SERVER computes the patch from
     * the screen's configuration — which only ever arrives through the gated
     * RPC — and merges it AFTER the child's interaction. Calling the same pure
     * function in a browser changes nothing, because the server recomputes it
     * and the server's result is what is persisted.
     */
    const navigation = readFileSync(
      join(repo, "src/features/mission-engine/navigation.ts"),
      "utf8",
    );
    expect(navigation).toContain("export function applyCanonicalTracker");
    expect(navigation).toContain("screenConfigByType[screen.type]");

    // The one runtime (server and Preview) applies it after the contract's
    // own reduction, so nothing the interaction carried can overwrite it.
    expect(runtimeSrc).toMatch(/applyCanonicalTracker\(out\.state, screen\)/);
    expect(runtimeSrc.indexOf("contract.apply(screen, interaction, state0, ctx)"))
      .toBeLessThan(runtimeSrc.indexOf("applyCanonicalTracker(out.state, screen)"));
  });

  it("there is exactly ONE canonical-tracker implementation", () => {
    // A second copy for Preview is the thing most likely to drift.
    const files = sourceFiles("src").filter((f) => !f.includes("__tests__"));
    const definitions = files.filter((f) =>
      /function applyCanonicalTracker\(/.test(readFileSync(f, "utf8")),
    );
    expect(definitions.map((f) => relative(repo, f).replaceAll("\\", "/"))).toEqual([
      "src/features/mission-engine/navigation.ts",
    ]);
  });

  it("a client cannot forge state through a `custom` interaction", () => {
    /*
     * `custom` names no screen, so it bypassed the current-screen check and
     * could write any key — including the canonical tracker. It is now
     * refused at the client boundary.
     */
    const model = buildModel({ definition: {}, screens: graph, completionRule: null });
    expect(() =>
      step(model, emptyMissionState, graph[0].screenKey,
        { kind: "custom", key: "tracker", value: { clarity: "forged" } }, new Date()),
    ).toThrow(EngineRefusal);
  });
});

// ─────────────────────────────────────────────────────── Judgement branches ──

describe("Judgement and reflection", () => {
  it.each(JUDGEMENTS)("$id reaches only its own reflection", (judgement) => {
    const { path } = play("ask_about_list", "share_the_role", judgement.id);
    expect(path).toContain(judgement.next);
    for (const other of ALL_REFLECTIONS) {
      if (other !== judgement.next) expect(path).not.toContain(other);
    }
  });

  it("reconsidering Decision 1 shows the unchosen response, never its consequence", () => {
    const config = parseScreenConfig(
      "reflection",
      byKey.get("reflection_d1")!.configuration,
    );
    // Labels only. Both were on screen when the child decided.
    expect(config.unusedOptions.map((o) => o.label)).toEqual([
      "Ask about the list",
      "Stop the claim spreading",
    ]);
    // No consequence text anywhere in the configuration.
    const serialised = JSON.stringify(
      byKey.get("reflection_d1")!.configuration,
    );
    expect(serialised).not.toContain("office assistant");
    expect(serialised).not.toContain("agree not to repeat");
    // One response is filtered out at render time by the child's own choice.
    expect(config.unusedFrom).toBe("decision1");
    expect(config.selectable).toBe(false);
  });

  it("reconsidering Decision 2 offers the two unchosen responses to consider", () => {
    const config = parseScreenConfig(
      "reflection",
      byKey.get("reflection_d2")!.configuration,
    );
    expect(config.unusedFrom).toBe("decision2");
    expect(config.selectable).toBe(true);
    expect(config.unusedPrompt).toBe("Which one would you now consider?");
    const serialised = JSON.stringify(
      byKey.get("reflection_d2")!.configuration,
    );
    for (const leak of [
      "disagreement reaches",
      "shares the role",
      "steps away from the project role",
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("no reflection collects or stores text", () => {
    for (const key of ALL_REFLECTIONS) {
      const s = byKey.get(key)!;
      expect(s.type).toBe("reflection");
      // The reflection schema has no input field of any kind: parsing would
      // succeed but there is nowhere for an answer to live.
      const config = parseScreenConfig("reflection", s.configuration);
      expect(config).not.toHaveProperty("inputType");
      expect(config).not.toHaveProperty("maxLength");
      expect(config).not.toHaveProperty("contributesToTrail");
    }
  });

  it("the reflection selection has no interaction kind to travel on", () => {
    // Screen 14C lets the child pick one unused response to consider. There is
    // deliberately no way to send that anywhere.
    const component = readFileSync(
      join(repo, "src/components/mission/screens/six-names-types.tsx"),
      "utf8",
    );
    const reflection = component.slice(
      component.indexOf("export function ReflectionScreen"),
    );
    // The only thing it ever sends is the advance, and the advance carries
    // nothing but the screen key.
    const sends = reflection.match(/onAdvance\(\{[^}]*\}\)/g) ?? [];
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('kind: "visit"');
    expect(sends[0]).not.toContain("considering");
    // And it has no other route to the server at all.
    expect(reflection).not.toContain("recordInteraction");
    expect(reflection).not.toContain("fetch(");
  });
});

// ─────────────────────────────────────────────────────── pause and resume ──

describe("pause and resume", () => {
  it("the stopping point offers a way out that does not advance", () => {
    const config = parseScreenConfig(
      "content",
      byKey.get("stopping_point")!.configuration,
    );
    expect(config.secondaryAction).toBe("Pause Mission");
    expect(config.actionLabel).toBe("Continue");
    // Continue goes to Evidence; pausing goes nowhere in the mission graph.
    expect(config.next).toBe("evidence");
  });

  it("resuming re-enters at the stopping point without repeating anything", () => {
    const { state } = play("ask_about_list", "share_the_role", "stand_by_both");

    /*
     * Rebuild the position from persisted state alone, as the server does on
     * return, and confirm navigation continues rather than replaying.
     */
    const resumed = resolveNextScreen(
      byKey.get("stopping_point")!,
      nextSequenceKey("stopping_point"),
      state,
    );
    expect(resumed).toBe("evidence");

    // The established branch and the opened reveal both survive.
    expect(state.choices.decision1).toBe("ask_about_list");
    expect(state.choices.decision2).toBe("share_the_role");
    expect(state.revealed).toContain("evidence");
  });

  it("re-entering an earlier screen never un-reveals or un-chooses", () => {
    const { state } = play(
      "stop_claim_spreading",
      "noor_steps_away",
      "reconsider_two",
    );
    const after = applyInteraction(state, {
      kind: "visit",
      screenKey: "changed_list",
    });
    expect(after.choices.decision1).toBe("stop_claim_spreading");
    expect(after.revealed).toContain("evidence");
  });
});

// ──────────────────────────────────────────────────────────── what is kept ──

describe("state to persist — and state that must not be", () => {
  it("keeps exactly the Brief's list and nothing resembling a prediction", () => {
    const { state } = play(
      "ask_about_list",
      "noor_steps_away",
      "reconsider_one",
    );

    expect(state.choices).toEqual({
      decision1: "ask_about_list",
      decision2: "noor_steps_away",
      judgement: "reconsider_one",
    });
    expect(state.revealed).toEqual(["evidence"]);
    expect(state.confirmedHandoffs).toEqual([
      "handoff_step3",
      "handoff_step7",
      "handoff_step11",
    ]);
    // Nothing was ever written as a response: no Final Judgement text, no
    // reflection text, no Screen 14 answer.
    expect(state.respondedScreens).toEqual([]);
  });

  it("no physical Concern choice is collected anywhere in the mission", () => {
    // The Concern cards are chosen on the Case Board. The Academy provides the
    // handoff around that and records nothing about it.
    expect(graph.some((s) => s.type === "multi_choice")).toBe(false);
    const { state } = play("ask_about_list", "share_the_role", "stand_by_both");
    expect(state.multiChoices).toEqual({});

    for (const concern of [
      "Stop an unfair claim",
      "Find out what the list means",
      "Protect the project",
      "Avoid making the rumour bigger",
    ]) {
      // Named in the printed Kit, never as a selectable option in the Academy.
      expect(seedCode).not.toContain(`'label', '${concern}'`);
    }
  });

  it("no tracker prediction is collected", () => {
    // The prediction happens against the physical tracker, before confirming.
    // It is a NOTE on the decision screen, with no field and no storage.
    for (const key of ["decision1", "decision2"]) {
      const config = parseScreenConfig("choice", byKey.get(key)!.configuration);
      expect(config.confirmNote).toBeUndefined();
    }
    expect(seedCode).toContain("'confirmNote'");
    expect(seedCode).toContain("make a quick prediction");
    // And there is no interactive tracker left in the mission at all.
    expect(graph.some((s) => s.type === "tracker")).toBe(false);
  });

  it("no response screen survives anywhere in the mission", () => {
    /*
     * Version 1 collected two: a judgement reflection and the Final Judgement
     * text. The Build Brief forbids both — the Final Judgement is written on
     * the physical card and must not be re-entered.
     */
    expect(graph.some((s) => s.type === "response")).toBe(false);
    expect(seedCode).not.toContain("'response'");
    expect(seedCode).not.toContain("contributesToTrail");
    expect(byKey.get("final_judgement")!.type).toBe("content");
  });

  it("the Final Judgement screen asks for nothing back", () => {
    const config = parseScreenConfig(
      "content",
      byKey.get("final_judgement")!.configuration,
    );
    expect(config.actionLabel).toBe("Complete Mission");
    // No prompts repeated on screen, no field, no upload.
    expect(config.reflectionPrompts).toEqual([]);
    expect(seedCode).not.toContain("upload");
  });
});

// ────────────────────────────────────────────────────────────── completion ──

describe("completion", () => {
  it("does NOT complete when the Judgement card is confirmed", () => {
    /*
     * The regression this guards: every other condition is satisfied the
     * moment Judgement is confirmed, so without `screen_visited:
     * final_judgement` the mission would complete from Screen 13 and skip both
     * the reflection and the Final Judgement.
     */
    let state = emptyMissionState;
    for (const key of ["evidence"]) {
      state = applyInteraction(state, { kind: "reveal", screenKey: key });
    }
    state = applyInteraction(state, {
      kind: "choice",
      screenKey: "decision1",
      optionId: "ask_about_list",
    });
    state = applyInteraction(state, {
      kind: "choice",
      screenKey: "decision2",
      optionId: "share_the_role",
    });
    state = applyInteraction(state, {
      kind: "choice",
      screenKey: "judgement",
      optionId: "stand_by_both",
    });

    expect(isMissionComplete(COMPLETION_RULE, state)).toBe(false);

    state = applyInteraction(state, {
      kind: "visit",
      screenKey: "final_judgement",
    });
    expect(isMissionComplete(COMPLETION_RULE, state)).toBe(true);
  });

  it("any Judgement card completes — none is correct", () => {
    for (const judgement of JUDGEMENTS) {
      const { path, completedAt } = play(
        "ask_about_list",
        "share_the_role",
        judgement.id,
      );
      expect(path.at(-1)).toBe("complete");
      expect(completedAt).toBe("final_judgement");
    }
  });

  it("the seeded rule matches the one under test", () => {
    for (const key of ["decision1", "decision2", "judgement"]) {
      expect(seedCode).toContain(
        `'kind', 'choice_exists',  'screenKey', '${key}'`,
      );
    }
    expect(seedCode).toContain(
      "'kind', 'screen_visited', 'screenKey', 'evidence'",
    );
    expect(seedCode).toContain(
      "'kind', 'screen_visited', 'screenKey', 'final_judgement'",
    );
  });

  it("requires no upload and stores no file", () => {
    const config = parseScreenConfig(
      "completion",
      byKey.get("complete")!.configuration,
    );
    expect(config.trailEntries).toHaveLength(3);
    expect(config.trailEntries.every((e) => e.type === "physical")).toBe(true);
    // A physical entry cannot name a file: the schema has no field for one.
    for (const entry of config.trailEntries) {
      expect(entry).not.toHaveProperty("storagePath");
      expect(entry).not.toHaveProperty("fromResponse");
    }
  });

  it("the Mission Trail is the physical artefacts, named as the Brief names them", () => {
    expect(seedCode).toContain("Six Names Case Board");
    expect(seedCode).toContain("What’s Changing? tracker");
    expect(seedCode).toContain("Final Judgement card");
    expect(seedCode).toContain(
      "Your Six Names Case Board and What’s Changing? tracker are your Mission Trail.",
    );
    expect(seedCode).toContain(
      "Your Mission Trail is private unless you choose to share part of it.",
    );
  });
});

// ─────────────────────────────────────────────────── authored copy, verbatim ──

describe("copy the Brief marks “Show exactly” is reproduced verbatim", () => {
  const exact = [
    // Decision 1 consequences
    "The office assistant says the head teacher is in a meeting and cannot answer yet. Pupils notice someone asking about the list. One says: “That proves it must be serious.”",
    "Some pupils agree not to repeat the claim. One asks why anyone would defend the named pupils unless they know something. The claim reaches another group, but several pupils now know that nobody has checked what the list means.",
    // Decision 2 consequences
    "Some agree that the list proves nothing. Others say refusing to act may allow copying to go unchallenged. The disagreement reaches nearly everyone involved in the project.",
    "Noor stays involved, but another pupil shares the role. Some people see this as a fair temporary solution. Others assume the shared role confirms that something suspicious happened.",
    "Noor steps away from the project role. Some pupils say this protects the project. Others treat the removal as proof that the accusation must be true.",
    // Evidence
    "The names belonged to pupils whose team-equipment records still needed checking. A crossed-out name meant the record had been completed. Jude and Zain were added because their equipment forms arrived late. The list was not about copying. A real issue still remained: several equipment records were incomplete and needed correcting.",
    // Final Judgement
    "Complete your Final Judgement and Grow in the Child Mission. Return here when you are finished.",
    // Stopping point
    "If you need a break, you can pause here.",
  ];

  it.each(exact)("%s", (line) => {
    expect(seed).toContain(line);
  });

  it("the seven Seen / Said / Unknown items are exact and correctly classified", () => {
    const config = parseScreenConfig(
      "sort_items",
      byKey.get("seen_said_unknown")!.configuration,
    );
    expect(config.items).toEqual([
      {
        id: "i1",
        text: "Six names are written on the paper.",
        classification: "seen",
      },
      { id: "i2", text: "The paper has no title.", classification: "seen" },
      {
        id: "i3",
        text: "The list is on the board outside the head teacher’s office.",
        classification: "seen",
      },
      {
        id: "i4",
        text: "Someone says the list is about copying.",
        classification: "said",
      },
      { id: "i5", text: "Who wrote the list?", classification: "unknown" },
      {
        id: "i6",
        text: "Why are these six names there?",
        classification: "unknown",
      },
      {
        id: "i7",
        text: "Is the copying claim true?",
        classification: "unknown",
      },
    ]);
    for (const item of config.items) {
      expect(seed).toContain(item.text);
    }
  });

  it("Seen / Said / Unknown are three equal choices, shuffled, and unscored", () => {
    const config = parseScreenConfig(
      "sort_items",
      byKey.get("seen_said_unknown")!.configuration,
    );
    expect(config.categories.map((c) => c.label)).toEqual([
      "Seen",
      "Said",
      "Unknown",
    ]);
    expect(config.shuffle).toBe(true);
    // Nothing in the schema can hold a result.
    expect(config).not.toHaveProperty("score");
    expect(config).not.toHaveProperty("correct");
    expect(seedCode).not.toMatch(
      /score|correct answer|right answer|mark(ed)? as wrong/i,
    );
  });

  it("the two decisions offer exactly the Brief's responses", () => {
    const d1 = parseScreenConfig(
      "choice",
      byKey.get("decision1")!.configuration,
    );
    expect(d1.options).toHaveLength(2);
    expect(d1.options.map((o) => o.label)).toEqual([
      "Ask about the list",
      "Stop the claim spreading",
    ]);

    const d2 = parseScreenConfig(
      "choice",
      byKey.get("decision2")!.configuration,
    );
    expect(d2.options).toHaveLength(3);
    expect(d2.options.map((o) => o.label)).toEqual([
      "Ask everyone to pause",
      "Continue, but share the role",
      "Suggest Noor steps away",
    ]);

    for (const option of [...d1.options, ...d2.options]) {
      expect(option.description).toBeTruthy();
      expect(seed).toContain(option.description!);
    }
  });

  it("the three Judgement cards are exact", () => {
    const config = parseScreenConfig(
      "choice",
      byKey.get("judgement")!.configuration,
    );
    expect(config.options.map((o) => o.label)).toEqual([
      "I stand by both decisions.",
      "I would reconsider Decision 1.",
      "I would reconsider Decision 2.",
    ]);
  });
});

// ─────────────────────────────────────────────────────────── the list object ──

describe("the list and the Changed List", () => {
  const listOf = (key: string) =>
    parseScreenConfig("content", byKey.get(key)!.configuration).listObject;

  it("the first list is six plain names", () => {
    expect(listOf("the_list").map((i) => i.text)).toEqual([
      "Noor",
      "Alex",
      "Sam",
      "Mika",
      "Ari",
      "Remy",
    ]);
    expect(listOf("the_list").every((i) => i.mark === "none")).toBe(true);
  });

  it("the Changed List keeps the original order and marks the changes", () => {
    const changed = listOf("changed_list");
    expect(changed.map((i) => i.text)).toEqual([
      "Noor",
      "Alex",
      "Sam",
      "Mika",
      "Ari",
      "Remy",
      "Jude",
      "Zain",
    ]);
    expect(changed.find((i) => i.text === "Mika")?.mark).toBe("struck");
    expect(changed.find((i) => i.text === "Jude")?.mark).toBe("added");
    expect(changed.find((i) => i.text === "Zain")?.mark).toBe("added");
    // Everything else is untouched, so the two lists read as the same sheet.
    for (const name of ["Noor", "Alex", "Sam", "Ari", "Remy"]) {
      expect(changed.find((i) => i.text === name)?.mark).toBe("none");
    }
  });

  it("the crossing-out is not conveyed by styling alone", () => {
    const component = readFileSync(
      join(repo, "src/components/mission/screens/six-names-types.tsx"),
      "utf8",
    );
    const list = component.slice(
      component.indexOf("export function ListObject"),
    );
    expect(list).toContain("(crossed out)");
    expect(list).toContain("(added)");
    expect(list).toContain("sr-only");
  });

  it("the first list carries no title, explanation or signature", () => {
    const s = byKey.get("the_list")!;
    expect(s.body).toBeNull();
    const config = parseScreenConfig("content", s.configuration);
    expect(config.reflectionPrompts).toEqual([]);
  });

  it("the revisit does not repeat the sorting activity or supply an answer key", () => {
    const s = byKey.get("ssu_revisit")!;
    expect(s.type).not.toBe("sort_items");
    const config = parseScreenConfig("content", s.configuration);
    expect(config.reflectionPrompts).toEqual([
      "What has visibly changed?",
      "What is still only said?",
      "What remains unknown?",
    ]);
  });
});

// ───────────────────────────────────────────────────────────── Mission Control ──

describe("Mission Control", () => {
  const withControl = graph.filter((s) => {
    const config = s.configuration as { missionControl?: unknown[] } | null;
    return (config?.missionControl?.length ?? 0) > 0;
  });

  it("appears only at the stages the Brief names", () => {
    expect(withControl.map((s) => s.screenKey).sort()).toEqual(
      [
        "handoff_step11",
        "handoff_step3",
        "handoff_step7",
        "seen_said_unknown",
      ].sort(),
    );
  });

  it("the consequence screens carry the 'I'm not sure what changed' support", () => {
    // Seeded on all five consequences; the graph above abbreviates them.
    const occurrences = seedCode.split("I’m not sure what changed.").length - 1;
    expect(occurrences).toBe(5);
  });

  it("uses the Brief's support options verbatim", () => {
    const support: [string, string][] = [
      [
        "I’m not sure what I know.",
        "Read the item again. Did you see this in the case? Did someone say it? Or has the case not told you yet?",
      ],
      [
        "I can’t choose a concern.",
        "You do not need to find the perfect concern. Look at all four cards and ask: Which one matters most to me right now, with what I know so far?",
      ],
      [
        "I’m not sure what changed.",
        "Read the consequence again. Look at Spread, Support and Clarity one at a time. What do you think each part should show now?",
      ],
      [
        "I’m not sure what matters now.",
        "Start with what changed after your first decision. Then look at the four Concern cards again. You can keep your first concern or choose a different one.",
      ],
      [
        "I’m not sure what I stand by.",
        "Take the two decisions one at a time. What did you know when you made each one? What was each choice trying to protect? Then choose the Judgement card that best matches your view now.",
      ],
    ];
    for (const [title, body] of support) {
      expect(seed).toContain(title);
      expect(seed).toContain(body);
    }
  });

  it("never reveals a consequence, the Evidence, or the meaning of the list", () => {
    const controls = seed.match(/'body',\s+'([^']|'')*'/g) ?? [];
    const joined = controls.join(" ");
    for (const leak of [
      "equipment",
      "office assistant",
      "was not about copying",
      "steps away from the project role",
    ]) {
      expect(joined.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("never recommends an option", () => {
    const controls = seed.match(/'body',\s+'([^']|'')*'/g) ?? [];
    for (const body of controls) {
      expect(body).not.toMatch(
        /you should|the best|the right choice|we recommend/i,
      );
    }
  });

  it("cannot advance the mission, by construction", () => {
    const component = readFileSync(
      join(repo, "src/components/mission/mission-control.tsx"),
      "utf8",
    );
    // It takes no state setter and emits no interaction.
    expect(component).not.toContain("onAdvance");
    expect(component).not.toContain("recordInteraction");
    expect(component).not.toContain("useTransition");
  });
});

// ────────────────────────────────────────────────────────────────── security ──

describe("staged information is server-authoritative", () => {
  it("mission_screens has no client read policy", () => {
    expect(access).toContain("drop policy");
    expect(access).toContain("mission_screens");
  });

  it("the gated RPC re-establishes the whole chain inside the function", () => {
    expect(access).toContain("not_your_child");
    expect(access).toContain("not_entitled");
    expect(access).toContain("security definer");
  });

  it("the key of an unused branch is no longer disclosed", () => {
    /*
     * Found by live execution: a child on `consequence1_ask` was told
     * next_sequence_key = `consequence1_stop`, the sibling they will never
     * reach. Withheld whenever the screen names its own destination.
     */
    expect(withholdNext).toContain("when s.configuration ? 'next' then null");
    expect(withholdNext).toContain(
      "jsonb_array_elements(s.configuration -> 'options')",
    );
    // Every v2 screen names its own destination, so nothing is disclosed.
    const declared = seedCode.match(/'next',\s*'[a-z0-9_]+'/g) ?? [];
    expect(declared.length).toBeGreaterThanOrEqual(graph.length - 1);
  });

  it("an interaction for a screen the child is not on is refused", () => {
    expect(persistence).toContain(
      "That interaction does not belong to the current step.",
    );
  });

  it("completion cannot be forged from the browser", () => {
    // The rule is evaluated server-side from pinned configuration, and the
    // write happens through the atomic RPC.
    // The runtime decides completion from pinned configuration; the only
    // write path is engine_save, which no client role may call (D-80).
    expect(persistence).toContain("complete: result.completed");
    expect(persistence).not.toContain("req.body.completed");
    expect(persistence).not.toMatch(/\.rpc\("(complete_mission|persist_mission_state)"/);
  });

  it("the client is never given more than one screen", () => {
    // The full model stays server-side; the page receives projectCurrent only.
    expect(persistence).toContain("projectCurrent(run.model");
    expect(persistence).not.toContain('.from("mission_screens")');
    const stageType = persistence.slice(persistence.indexOf("export type MissionStage"));
    expect(stageType.slice(0, stageType.indexOf("};"))).not.toMatch(/model|screens:/);
  });
});

// ───────────────────────────────────────────────────────────── seed integrity ──

describe("seed integrity", () => {
  it("declares every screen the graph under test references", () => {
    for (const s of graph) {
      expect(seedCode).toContain(`'${s.screenKey}'`);
    }
  });

  it("declares the screens at the types the graph expects", () => {
    for (const s of graph) {
      expect(seedCode).toMatch(new RegExp(`'${s.screenKey}',\\s*'${s.type}'`));
    }
  });

  it("every branch target and `next` refers to a declared screen", () => {
    const keys = new Set(graph.map((s) => s.screenKey));
    for (const s of graph) {
      const config = s.configuration as {
        next?: string;
        options?: { next?: string }[];
      };
      if (config.next) expect(keys).toContain(config.next);
      for (const option of config.options ?? []) {
        if (option.next) expect(keys).toContain(option.next);
      }
    }
  });

  it("seeds version 2 and leaves version 1 untouched", () => {
    // D-17 pins an in-progress run to the version it started with.
    expect(seedCode).toContain(
      "delete from mission_screens where mission_id = m and version = 2",
    );
    expect(seedCode).not.toContain("version = 1");
    expect(seedCode).toContain("set version = 2");
  });

  it("contains no score, badge, streak or ranking language", () => {
    expect(seedCode).not.toMatch(
      /\b(score|points|badge|streak|leaderboard|rank|level up|well done|correct!)\b/i,
    );
  });

  it("asks for no real names, school details or identifying information", () => {
    expect(seedCode).not.toMatch(
      /your school|real name|your teacher|upload a photo/i,
    );
  });

  it("every screen type in the graph has a registered component", () => {
    const renderer = readFileSync(
      join(repo, "src/features/mission-engine/renderer.tsx"),
      "utf8",
    );
    for (const type of new Set(graph.map((s) => s.type))) {
      expect(renderer).toMatch(new RegExp(`\\b${type}:\\s*\\w+Screen`));
    }
  });

  it("the new screen types exist in the database enum", () => {
    const migration = readFileSync(
      join(
        repo,
        "supabase/migrations/20260927100000_six_names_screen_types.sql",
      ),
      "utf8",
    );
    for (const type of ["sort_items", "tracker_confirmation", "reflection"]) {
      expect(migration).toContain(`add value if not exists '${type}'`);
    }
  });
});


// ─────────────────────────────────── foundation runtime: Six Names unchanged ──

describe("Six Names on the foundation runtime (D-80, no redesign)", () => {
  const routes = D1.flatMap((a) => D2.map((b) => [a.id, b.id] as const));
  it.each(routes)("%s → %s: same path and same state as the legacy engine", (a, b) => {
    for (const j of JUDGEMENTS) {
      const legacy = play(a, b, j.id);
      const now = playRuntime(a, b, j.id);
      const legacyUntilDone = legacy.path.slice(0, legacy.path.indexOf(legacy.completedAt!) + 1);
      expect(now.path).toEqual(legacyUntilDone);
      expect(now.completed).toBe(true);
      expect(now.state.choices).toEqual(legacy.state.choices);
      // The canonical tracker the server applies (the legacy reducer above
      // never applied it): Evidence changes only Clarity.
      const t = now.state.custom.tracker as Record<string, string>;
      expect(t.spread).toBe("Nearly everyone");
      expect(t.clarity).toBe("Purpose clear");
      expect(now.state.revealed).toEqual(["evidence"]);
    }
  });

  it("a forged `visit` cannot skip a decision", () => {
    const model = buildModel({ definition: {}, screens: graph, completionRule: COMPLETION_RULE });
    expect(() => step(model, emptyMissionState, "decision1", { kind: "visit", screenKey: "decision1" }, new Date()))
      .toThrow(EngineRefusal);
  });

  it("Continue cannot skip Evidence before it is opened", () => {
    const model = buildModel({ definition: {}, screens: graph, completionRule: COMPLETION_RULE });
    const r = step(model, emptyMissionState, "evidence", { kind: "visit", screenKey: "evidence" }, new Date());
    expect(r.ok).toBe(false);
  });

  it("the unopened Evidence never reaches the browser (D-81)", () => {
    const model = buildModel({ definition: {}, screens: graph, completionRule: COMPLETION_RULE });
    const evidence = byKey.get("evidence")!;
    const before = JSON.stringify(projectScreen(model, evidence, emptyMissionState, new Date()));
    const body = parseScreenConfig("reveal", evidence.configuration).revealedBody;
    expect(before).not.toContain(body.slice(0, 40));
    expect(before).not.toContain("canonicalTracker");
    expect(before).not.toContain('"next"');
    const after = JSON.stringify(projectScreen(model, evidence, { ...emptyMissionState, revealed: ["evidence"] }, new Date()));
    expect(after).toContain(body.slice(0, 40));
  });

  it("a decision's projection names no destination", () => {
    const model = buildModel({ definition: {}, screens: graph, completionRule: COMPLETION_RULE });
    const p = JSON.stringify(projectScreen(model, byKey.get("decision1")!, emptyMissionState, new Date()));
    expect(p).not.toContain("consequence1_");
  });
});

// ──────────────────────────────── automated mission QA on the reference mission ──

describe("automated mission QA passes Six Names v2 (the reference mission)", () => {
  it("has no blocking issue, and every one of its 18 routes completes", async () => {
    const { validateMission } = await import("../validator");
    const model = buildModel({ definition: {}, screens: graph, completionRule: COMPLETION_RULE });
    const { issues, paths } = validateMission(model);
    expect(issues.filter((i) => i.severity === "blocking")).toEqual([]);
    expect(paths.filter((p) => p.outcome === "complete")).toHaveLength(2 * 3 * 3);
    expect(paths.every((p) => p.outcome === "complete")).toBe(true);
    // and no path ever shows both consequences of one decision
    for (const p of paths) {
      expect(p.screens.filter((k) => k.startsWith("consequence1_"))).toHaveLength(1);
      expect(p.screens.filter((k) => k.startsWith("consequence2_"))).toHaveLength(1);
    }
  });
});
