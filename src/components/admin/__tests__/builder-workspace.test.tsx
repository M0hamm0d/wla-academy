import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/*
 * THE MISSION BUILDER, RENDERED (D-115..D-122).
 *
 * These render the real components and drive them as an author would. The
 * server actions are replaced by spies that return what the real ones return,
 * because what is under test is the interface's behaviour around them —
 * unsaved work, confirmation, wording — not the database. The database's own
 * guarantees (immutability, the publish gate) are covered by the SQL and
 * engine suites, which these changes do not touch.
 */

const actions = vi.hoisted(() => ({
  saveScreenAction: vi.fn(async () => ({ ok: true })),
  deleteScreenAction: vi.fn(async () => ({})),
  moveScreenAction: vi.fn(async () => undefined),
  setCompletionRuleAction: vi.fn(async () => ({ ok: true })),
  setVersionStatusAction: vi.fn(async () => ({ ok: true })),
  saveDefinitionAction: vi.fn(async () => ({ ok: true })),
  insertPatternAction: vi.fn(async () => ({ ok: true })),
  createVersionAction: vi.fn(async () => ({})),
}));
const push = vi.hoisted(() => vi.fn());
const back = vi.hoisted(() => vi.fn());

vi.mock("@/features/admin/builder-actions", () => actions);
vi.mock("@/features/admin/kit-actions", () => ({
  saveKitResourceAction: vi.fn(async () => ({ ok: true })),
  deleteKitResourceAction: vi.fn(async () => ({})),
  moveKitResourceAction: vi.fn(async () => undefined),
  saveParentNoteAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/features/admin/asset-actions", () => ({
  saveAssetAction: vi.fn(async () => ({ ok: true })),
  deleteAssetAction: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back, push, refresh: vi.fn() }) }));
const saveMission = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: "Saved." })));
vi.mock("@/features/admin/actions", () => ({ saveMissionAction: saveMission }));

import { BuilderWorkspace } from "../builder-workspace";
import * as kitActions from "@/features/admin/kit-actions";
import * as assetActions from "@/features/admin/asset-actions";
import { UnsavedChangesProvider } from "../unsaved-changes";
import { CompletionPanel } from "../completion-panel";
import { CreateDraftButton } from "../create-draft-button";
import { MissionForm } from "../mission-form";
import type { MissionRow } from "@/types/database";
import type { BuilderFacts } from "@/features/admin/builder-readiness";

const screensFixture = [
  { screen_key: "intro", type: "content", title: "Welcome", body: null, sequence: 10, configuration: { next: "pick" } },
  { screen_key: "pick", type: "choice", title: "Pick a path", body: null, sequence: 20, configuration: { prompt: "Which way?", options: [{ id: "a", label: "Left", next: "end" }, { id: "b", label: "Right", next: "end" }] } },
  { screen_key: "end", type: "completion", title: "The end", body: null, sequence: 30, configuration: { message: "Done", trailEntries: [] } },
];

const facts: BuilderFacts = {
  issues: [],
  screenCount: 3,
  resourceCount: 0,
  hasParentNote: false,
  hasCompletion: true,
  logicInUse: 0,
  mediaCount: 0,
  details: { description: "x", coverImage: "x", priceMinor: 100, isFree: false },
  paths: { total: 2, complete: 2 },
};

type Issue = { code: string; blocking: boolean; screen_key: string | null; detail: string; category?: string };

const resourceFixture = { id: "r1", title: "Case board", description: null, type: "pdf", storage_path: "m1/3/case-board.pdf", can_view: true, can_print: true, can_download: true, sort_order: 10, file_url: null };

function renderWorkspace(over: { screens?: typeof screensFixture; blocking?: Issue[]; advisory?: Issue[]; status?: string; rule?: unknown; resources?: (typeof resourceFixture)[] } = {}) {
  const screens = over.screens ?? screensFixture;
  const blocking = over.blocking ?? [];
  return render(
    <UnsavedChangesProvider>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- stands in for the admin sidebar's link, which renders an <a> */}
      <a href="/admin/missions">Missions (sidebar)</a>
      <BuilderWorkspace
        missionId="m1"
        slug="demo"
        version={3}
        status={over.status ?? "draft"}
        completionRule={over.rule === undefined ? { type: "screen_reached", screenKey: "end" } : over.rule}
        screens={screens}
        blocking={blocking}
        advisory={over.advisory ?? []}
        resources={over.resources ?? []}
        noteContent={null}
        noteDocumentPath={null}
        noteDocumentUrl={null}
        facts={{ ...facts, screenCount: screens.length, issues: [...blocking, ...(over.advisory ?? [])] }}
        publishImpact={["New learners who start this mission will get version 3.", "Version 2 stops being offered to new learners and is archived, not deleted. 4 learners partway through version 2 will stay on it."]}
      />
    </UnsavedChangesProvider>,
  );
}

const card = (title: string) => screen.getByText(title, { selector: "p.font-medium" }).closest("li") as HTMLElement;
const openEditor = (title: string) => fireEvent.click(within(card(title)).getByRole("button", { name: new RegExp(`^Edit ${title}`) }));
const discardDialog = () => screen.queryByRole("alertdialog", { name: "Discard unsaved changes?" });

beforeEach(() => {
  vi.clearAllMocks();
  actions.saveScreenAction.mockImplementation(async () => ({ ok: true }));
});

describe("unsaved changes are never lost silently (D-118)", () => {
  it("switching screens with an unsaved edit asks first, and Keep editing keeps it", async () => {
    renderWorkspace();
    openEditor("Welcome");
    const title = within(card("Welcome")).getByLabelText("Title") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Welcome, explorer" } });
    await waitFor(() => expect(within(card("Welcome")).getByText("Unsaved changes")).toBeDefined());

    openEditor("Pick a path");
    const dialog = await waitFor(() => discardDialog()!);
    expect(within(dialog).getByText(/the screen “Welcome”/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));

    expect(discardDialog()).toBeNull();
    expect((within(card("Welcome")).getByLabelText("Title") as HTMLInputElement).value).toBe("Welcome, explorer");
    expect(within(card("Pick a path")).queryByLabelText("Title")).toBeNull();
  });

  it("Discard changes switches, and the edit is gone", async () => {
    renderWorkspace();
    openEditor("Welcome");
    fireEvent.change(within(card("Welcome")).getByLabelText("Title"), { target: { value: "Changed" } });
    await waitFor(() => within(card("Welcome")).getByText("Unsaved changes"));
    openEditor("Pick a path");
    fireEvent.click(within(await waitFor(() => discardDialog()!)).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(within(card("Pick a path")).getByLabelText("Title")).toBeDefined());
    expect(within(card("Welcome")).queryByLabelText("Title")).toBeNull();
  });

  it("closing an editor with unsaved changes asks; closing an untouched one does not", async () => {
    renderWorkspace();
    openEditor("Welcome");
    fireEvent.click(within(card("Welcome")).getByRole("button", { name: "Close Welcome" }));
    expect(discardDialog()).toBeNull();
    expect(within(card("Welcome")).queryByLabelText("Title")).toBeNull();

    openEditor("Welcome");
    fireEvent.change(within(card("Welcome")).getByLabelText("Body"), { target: { value: "New body" } });
    await waitFor(() => within(card("Welcome")).getByText("Unsaved changes"));
    fireEvent.click(within(card("Welcome")).getByRole("button", { name: "Close Welcome" }));
    expect(await waitFor(() => discardDialog())).not.toBeNull();
  });

  it("a successful save clears the warning; switching then needs no confirmation", async () => {
    renderWorkspace();
    openEditor("Welcome");
    fireEvent.change(within(card("Welcome")).getByLabelText("Title"), { target: { value: "Saved title" } });
    await waitFor(() => within(card("Welcome")).getByText("Unsaved changes"));
    await act(async () => { fireEvent.click(within(card("Welcome")).getByRole("button", { name: "Save screen" })); });
    await waitFor(() => expect(actions.saveScreenAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(card("Welcome")).queryByText("Unsaved changes")).toBeNull());
    const posted = (actions.saveScreenAction.mock.calls[0] as unknown[])[1] as FormData;
    expect(posted.get("title")).toBe("Saved title");
    expect(posted.get("screen_key")).toBe("intro");

    openEditor("Pick a path");
    expect(discardDialog()).toBeNull();
  });

  it("a failed save keeps the content marked unsaved", async () => {
    actions.saveScreenAction.mockImplementation(async () => ({ error: "We couldn't save that screen." }) as never);
    renderWorkspace();
    openEditor("Welcome");
    fireEvent.change(within(card("Welcome")).getByLabelText("Title"), { target: { value: "Will fail" } });
    // Body is uncontrolled: React 19 used to reset it after ANY form action.
    fireEvent.change(within(card("Welcome")).getByLabelText("Body"), { target: { value: "Typed before a failed save" } });
    await act(async () => { fireEvent.click(within(card("Welcome")).getByRole("button", { name: "Save screen" })); });
    await waitFor(() => within(card("Welcome")).getByText("We couldn't save that screen."));
    expect(within(card("Welcome")).getByText("Unsaved changes")).toBeDefined();
    expect((within(card("Welcome")).getByLabelText("Body") as HTMLTextAreaElement).value).toBe("Typed before a failed save");
    expect((within(card("Welcome")).getByLabelText("Title") as HTMLInputElement).value).toBe("Will fail");
    openEditor("Pick a path");
    expect(await waitFor(() => discardDialog())).not.toBeNull();
  });

  it("leaving the page warns: a link click asks, and reload/close is blocked by the browser prompt", async () => {
    renderWorkspace();
    openEditor("Welcome");
    fireEvent.change(within(card("Welcome")).getByLabelText("Title"), { target: { value: "x" } });
    await waitFor(() => within(card("Welcome")).getByText("Unsaved changes"));

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByText("Missions (sidebar)"));
    const dialog = await waitFor(() => discardDialog()!);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(push).toHaveBeenCalledWith("/admin/missions");
  });

  it("with nothing unsaved, links and reloads are not interrupted", () => {
    renderWorkspace();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByText("Missions (sidebar)"));
    expect(discardDialog()).toBeNull();
  });
});

describe("new screens: suggested keys, never a clash (D-117)", () => {
  it("suggests a key from the title, unique in the version, and posts it as new", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Add a screen" }));
    const form = document.getElementById("new-screen") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Welcome" } });
    const key = within(form).getByLabelText("Screen key") as HTMLInputElement;
    // "welcome" is free (the intro is keyed "intro"), so it is used as is.
    expect(key.value).toBe("welcome");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Intro" } });
    expect(key.value).toBe("intro_2");

    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Add screen" })); });
    await waitFor(() => expect(actions.saveScreenAction).toHaveBeenCalled());
    const posted = (actions.saveScreenAction.mock.calls[0] as unknown[])[1] as FormData;
    expect(posted.get("screen_key")).toBe("intro_2");
    expect(posted.get("isNew")).toBe("1");
  });

  it("an author's own key is kept even when the title changes", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Add a screen" }));
    const form = document.getElementById("new-screen") as HTMLElement;
    const key = within(form).getByLabelText("Screen key") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "my_key" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Anything" } });
    expect(key.value).toBe("my_key");
  });

  it("an existing screen's key stays read-only", () => {
    renderWorkspace();
    openEditor("Welcome");
    expect((within(card("Welcome")).getByLabelText("Screen key") as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("the empty state offers two starts and creates nothing by itself", () => {
  it("explains screens and opens the editor without calling any action", () => {
    renderWorkspace({ screens: [] });
    expect(screen.getByText("Start building the mission")).toBeDefined();
    expect(screen.getByText("Start from a proven pattern")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add your first screen" }));
    expect(document.getElementById("new-screen")).not.toBeNull();
    expect(actions.saveScreenAction).not.toHaveBeenCalled();
    expect(actions.insertPatternAction).not.toHaveBeenCalled();
  });
});

describe("validation is actionable and named by title", () => {
  const blocking: Issue[] = [{ code: "dead_end", blocking: true, screen_key: "pick", detail: "Nothing follows this screen, and it is not the completion screen.", category: "structure" }];

  it("lists the problem under its section with the screen's title, and opens that screen", async () => {
    renderWorkspace({ blocking });
    const review = screen.getByRole("heading", { name: "Review & publish" }).closest("section") as HTMLElement;
    expect(within(review).getByText("Must fix before publishing (1)")).toBeDefined();
    expect(within(review).getByText("Screens & flow")).toBeDefined();
    expect(within(review).getByText("Pick a path:")).toBeDefined();
    expect(within(review).getByText(/A learner who reaches it is stranded/)).toBeDefined();
    fireEvent.click(within(review).getByRole("button", { name: /Open this screen/ }));
    await waitFor(() => expect(within(card("Pick a path")).getByLabelText("Title")).toBeDefined());
  });

  it("marks the problem on the card in words, not colour alone", () => {
    renderWorkspace({ blocking });
    expect(within(card("Pick a path")).getByText("Must fix:")).toBeDefined();
  });

  it("publishing and review are unavailable while problems remain, and say why", () => {
    renderWorkspace({ blocking });
    expect((screen.getByRole("button", { name: "Publish version 3 for learners…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Mark as ready for review" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/unavailable while 1 problem needs fixing/)).toBeDefined();
  });
});

describe("publishing asks first and states real consequences (D-121)", () => {
  it("opens a confirmation with the impact; Cancel publishes nothing", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Publish version 3 for learners…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Publish version 3 for learners?" });
    expect(within(dialog).getByText(/4 learners partway through version 2 will stay on it/)).toBeDefined();
    expect(within(dialog).getByText(/They run again when you confirm, and nothing is published if they fail/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(actions.setVersionStatusAction).not.toHaveBeenCalled();
  });

  it("Confirm posts status=published once, and reports the outcome", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Publish version 3 for learners…" }));
    const dialog = screen.getByRole("alertdialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Publish version 3" })); });
    await waitFor(() => expect(actions.setVersionStatusAction).toHaveBeenCalledTimes(1));
    const posted = (actions.setVersionStatusAction.mock.calls[0] as unknown[])[1] as FormData;
    expect(posted.get("status")).toBe("published");
    expect(posted.get("version")).toBe("3");
    await waitFor(() => expect(screen.getByText("Version 3 is now live for learners.")).toBeDefined());
  });

  it("a refused publish shows the server's reason in the dialog", async () => {
    actions.setVersionStatusAction.mockImplementationOnce(async () => ({ error: "Mission QA found 1 problem that must be fixed first. They are listed under Review." }) as never);
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Publish version 3 for learners…" }));
    const dialog = screen.getByRole("alertdialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Publish version 3" })); });
    await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByText(/Mission QA found 1 problem/)).toBeDefined());
  });
});

describe("preview and the flow map lead to the right place", () => {
  it("each screen offers Preview from here, using the existing safe preview route", () => {
    renderWorkspace();
    const link = within(card("Pick a path")).getByRole("link", { name: /Preview from here/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/admin/builder/demo/3/preview?from=pick");
  });

  it("selecting a screen on the flow map opens its editor", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /^Open The end — Completion/ }));
    await waitFor(() => expect(within(card("The end")).getByLabelText("Title")).toBeDefined());
  });
});

describe("headings never skip a level (rendered)", () => {
  const skipsIn = (container: HTMLElement) => {
    let lastLevel = 1;
    const skips: string[] = [];
    for (const h of Array.from(container.querySelectorAll("h1,h2,h3,h4"))) {
      const level = Number(h.tagName[1]);
      if (level > lastLevel + 1) skips.push(`${h.tagName} "${h.textContent}" after h${lastLevel}`);
      lastLevel = level;
    }
    return skips;
  };

  it("with blocking problems and suggestions", () => {
    const { container } = renderWorkspace({
      blocking: [{ code: "dead_end", blocking: true, screen_key: "pick", detail: "x" }],
      advisory: [{ code: "screen_without_title", blocking: false, screen_key: "intro", detail: "y" }],
    });
    expect(skipsIn(container)).toEqual([]);
  });

  it("with suggestions only (found by the browser check: h2 → h4)", () => {
    const { container } = renderWorkspace({ advisory: [{ code: "screen_without_title", blocking: false, screen_key: "intro", detail: "y" }] });
    expect(skipsIn(container)).toEqual([]);
  });

  it("empty", () => {
    const { container } = renderWorkspace({ screens: [] });
    expect(skipsIn(container)).toEqual([]);
  });
});

describe("completion: an ordinary rule without JSON, custom rules preserved (D-115)", () => {
  const screens = screensFixture.map((s) => ({ screen_key: s.screen_key, title: s.title, type: s.type }));
  const renderPanel = (rule: unknown, definitionCompletion?: unknown) =>
    render(
      <UnsavedChangesProvider>
        <CompletionPanel missionId="m1" slug="demo" version={3} rule={rule} definitionCompletion={definitionCompletion} screens={screens} />
      </UnsavedChangesProvider>,
    );

  it("a basic rule opens in the form, says what is in force, and saves the same shape", async () => {
    renderPanel({ type: "screen_reached", screenKey: "end" });
    expect(screen.getByText(/Complete when the child reaches “The end”\./)).toBeDefined();
    expect((screen.getByLabelText("When the child reaches a screen") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Mark the mission complete when the child reaches") as HTMLSelectElement).value).toBe("end");

    fireEvent.change(screen.getByLabelText("Mark the mission complete when the child reaches"), { target: { value: "pick" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save completion rule" })); });
    await waitFor(() => expect(actions.setCompletionRuleAction).toHaveBeenCalled());
    const posted = (actions.setCompletionRuleAction.mock.calls[0] as unknown[])[1] as FormData;
    expect(JSON.parse(String(posted.get("rule")))).toEqual({ type: "screen_reached", screenKey: "pick" });
  });

  it("a custom rule opens in Advanced, untouched, and is posted verbatim if saved", async () => {
    const rule = { type: "conditions", conditions: [{ kind: "response_exists", screenKey: "pick" }] };
    renderPanel(rule);
    expect((screen.getByLabelText("A custom rule (advanced)") as HTMLInputElement).checked).toBe(true);
    expect(JSON.parse((screen.getByLabelText("Custom rule (JSON)") as HTMLTextAreaElement).value)).toEqual(rule);
    // Opening it changed nothing, so nothing is unsaved.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save completion rule" })); });
    await waitFor(() => expect(actions.setCompletionRuleAction).toHaveBeenCalled());
    const posted = (actions.setCompletionRuleAction.mock.calls[0] as unknown[])[1] as FormData;
    expect(JSON.parse(String(posted.get("rule")))).toEqual(rule);
  });

  it("switching a custom rule to the basic form warns that saving replaces it", () => {
    renderPanel({ type: "conditions", conditions: [{ kind: "response_exists", screenKey: "pick" }] });
    fireEvent.click(screen.getByLabelText("When the child reaches a screen"));
    expect(screen.getByRole("note").textContent).toMatch(/currently has a custom rule .*Saving will replace it/);
  });

  it("when Mission logic's condition is set, the panel says the rule is not used", () => {
    renderPanel({ type: "screen_reached", screenKey: "end" }, { ref: { response: "pick" }, op: "exists" });
    expect(screen.getByText(/set by the completion condition in Mission logic/)).toBeDefined();
    expect(screen.getByText(/is kept, but isn’t used while that condition is set/)).toBeDefined();
  });
});

describe("a locked version starts a new draft directly (D-119)", () => {
  it("offers one explicit action when no draft exists", () => {
    render(<CreateDraftButton missionId="m1" slug="demo" version={2} openDraft={null} />);
    expect(screen.getByRole("button", { name: "Create a new draft from version 2" })).toBeDefined();
    expect(screen.getByText(/Version 2 stays exactly as it is/)).toBeDefined();
  });

  it("points to the existing draft instead of making a second", () => {
    render(<CreateDraftButton missionId="m1" slug="demo" version={2} openDraft={3} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect((screen.getByRole("link", { name: "Open version 3" }) as HTMLAnchorElement).getAttribute("href")).toBe("/admin/builder/demo/3");
  });
});

describe("unsaved-change protection covers every editor, not only screens (D-118)", () => {
  const formOf = (el: HTMLElement) => el.closest("form") as HTMLElement;
  const unloadBlocked = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

  it("parent note: marks unsaved, warns on leaving, and Discard restores the saved text", async () => {
    renderWorkspace();
    const note = screen.getByLabelText("Note") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "Draft note" } });
    await waitFor(() => within(formOf(note)).getByText("Unsaved changes"));
    expect(unloadBlocked()).toBe(true);
    fireEvent.click(within(formOf(note)).getByRole("button", { name: "Discard changes" }));
    const dialog = await waitFor(() => discardDialog()!);
    expect(within(dialog).getByText(/the note For Parents/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(""));
    expect(unloadBlocked()).toBe(false);
  });

  it("new Kit resource: Cancel with a typed name asks first", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Add a resource" }));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Case board" } });
    await waitFor(() => within(formOf(name)).getByText("Unsaved changes"));
    fireEvent.click(within(formOf(name)).getByRole("button", { name: "Cancel" }));
    expect(within(await waitFor(() => discardDialog()!)).getByText(/the new Kit resource/)).toBeDefined();
  });

  it("mission logic: a change is tracked and following a link asks first", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Add completion condition" }));
    const save = screen.getByRole("button", { name: "Save mission logic" });
    await waitFor(() => within(formOf(save)).getByText("Unsaved changes"));
    fireEvent.click(screen.getByText("Missions (sidebar)"));
    expect(within(await waitFor(() => discardDialog()!)).getByText(/Mission logic/)).toBeDefined();
  });

  it("new media: a typed key is tracked", async () => {
    renderWorkspace();
    const key = screen.getAllByLabelText("Key")[0] as HTMLInputElement;
    fireEvent.change(key, { target: { value: "bridge_photo" } });
    await waitFor(() => within(formOf(key)).getByText("Unsaved changes"));
    expect(unloadBlocked()).toBe(true);
  });

  it("opening an editor without typing never prompts", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Add a resource" }));
    fireEvent.click(within(formOf(screen.getByLabelText("Name"))).getByRole("button", { name: "Cancel" }));
    expect(discardDialog()).toBeNull();
    expect(unloadBlocked()).toBe(false);
  });
});

describe("mission details form: catalogue wording and unsaved protection", () => {
  // Fixture data, not UI: named so scoping.test.ts's "no hard-coded currency in components" guard stays strict.
  const FIXTURE_CURRENCY = "GBP";
  const mission = { id: "m1", slug: "demo", title: "Demo", description: null, lab: "challenge", min_age: 7, max_age: 11, duration: null, delivery_type: "physical", cover_image: null, price_minor: 1200, currency: FIXTURE_CURRENCY, completion_rule: null, is_free: false, version: 2, published: false, created_at: "", updated_at: "" } as MissionRow;
  const renderForm = () => render(<UnsavedChangesProvider><MissionForm mission={mission} versionUsage={[]} /></UnsavedChangesProvider>);

  it("labels catalogue visibility apart from version publishing", () => {
    renderForm();
    expect(screen.getByLabelText("Show in catalogue (available to buy)")).toBeDefined();
    expect(screen.getByText(/separate from publishing a version/)).toBeDefined();
  });

  it("clears the warning after a successful save, keeps it after a failed one", async () => {
    saveMission.mockImplementationOnce(async () => ({ ok: false, message: "We couldn't save." }) as never);
    renderForm();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Demo 2" } });
    await waitFor(() => screen.getByText("Unsaved changes"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
    await waitFor(() => screen.getByText("We couldn't save."));
    expect(screen.getByText("Unsaved changes")).toBeDefined();
    expect(title.value).toBe("Demo 2");
    expect(back).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
  });
});

describe("a failed save keeps what was typed in every editor; a successful one clears the warning", () => {
  const FAIL = { error: "Save failed (test)." };
  const formOf = (el: HTMLElement) => el.closest("form") as HTMLElement;

  type Case = {
    name: string;
    open?: () => void;
    field: () => HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    value: string;
    save: string;
    failOnce: () => void;
  };
  const cases: Case[] = [
    {
      name: "Kit resource (uncontrolled fields)",
      open: () => fireEvent.click(screen.getByRole("button", { name: "Edit Case board" })),
      field: () => screen.getByLabelText("Name") as HTMLInputElement,
      value: "Case board, revised",
      save: "Save resource",
      failOnce: () => vi.mocked(kitActions.saveKitResourceAction).mockImplementationOnce(async () => FAIL as never),
    },
    {
      name: "parent note",
      field: () => screen.getByLabelText("Note") as HTMLTextAreaElement,
      value: "Talk about the choices together.",
      save: "Save parent note",
      failOnce: () => vi.mocked(kitActions.saveParentNoteAction).mockImplementationOnce(async () => FAIL as never),
    },
    {
      name: "new media (uncontrolled fields)",
      field: () => screen.getAllByLabelText("Key")[0] as HTMLInputElement,
      value: "bridge_photo",
      save: "Add media",
      failOnce: () => vi.mocked(assetActions.saveAssetAction).mockImplementationOnce(async () => FAIL as never),
    },
    {
      name: "completion rule",
      field: () => screen.getByLabelText("Mark the mission complete when the child reaches") as HTMLSelectElement,
      value: "pick",
      save: "Save completion rule",
      failOnce: () => actions.setCompletionRuleAction.mockImplementationOnce(async () => FAIL as never),
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      renderWorkspace({ resources: [resourceFixture] });
      c.open?.();
      fireEvent.change(c.field(), { target: { value: c.value } });
      const form = formOf(c.field());
      await waitFor(() => within(form).getByText("Unsaved changes"));

      c.failOnce();
      await act(async () => { fireEvent.click(within(form).getByRole("button", { name: c.save })); });
      await waitFor(() => within(formOf(c.field())).getByText("Save failed (test)."));
      expect(c.field().value).toBe(c.value);
      expect(within(formOf(c.field())).getByText("Unsaved changes")).toBeDefined();

      await act(async () => { fireEvent.click(within(formOf(c.field())).getByRole("button", { name: c.save })); });
      await waitFor(() => expect(within(formOf(c.field())).queryByText("Unsaved changes")).toBeNull());
    });
  }

  it("mission logic", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Add completion condition" }));
    const save = () => screen.getByRole("button", { name: "Save mission logic" });
    await waitFor(() => within(formOf(save())).getByText("Unsaved changes"));
    actions.saveDefinitionAction.mockImplementationOnce(async () => FAIL as never);
    await act(async () => { fireEvent.click(save()); });
    await waitFor(() => within(formOf(save())).getByText("Save failed (test)."));
    // The added condition is still there, and still unsaved.
    expect(screen.getByRole("button", { name: "Remove completion condition" })).toBeDefined();
    expect(within(formOf(save())).getByText("Unsaved changes")).toBeDefined();
    await act(async () => { fireEvent.click(save()); });
    await waitFor(() => expect(within(formOf(save())).queryByText("Unsaved changes")).toBeNull());
  });

  it("a successfully added media item empties the form for the next one", async () => {
    renderWorkspace();
    const key = () => screen.getAllByLabelText("Key")[0] as HTMLInputElement;
    fireEvent.change(key(), { target: { value: "first_photo" } });
    await act(async () => { fireEvent.click(within(formOf(key())).getByRole("button", { name: "Add media" })); });
    await waitFor(() => expect(key().value).toBe(""));
    expect(within(formOf(key())).queryByText("Unsaved changes")).toBeNull();
  });
});
