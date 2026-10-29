import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  flowOf,
  installationStatus,
  installScreenOf,
  op,
  overviewOf,
  settingsOf,
  skillLoadsOf,
  surfaceStatus,
} from "../test/pageFixtures";
import type {
  ActionResult,
  AgentTargetMeta,
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  InstallationState,
  RulesConversionPreview,
  RulesDiffView,
  RulesStatus,
  SetupResult,
  SetupSurfaceId,
} from "../types";
import { ClaudeView } from "./ClaudeView";
import { CodexView } from "./CodexView";
import { CursorView } from "./CursorView";
import type { HarnessViewProps } from "./pageTypes";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  // The page also reads the harness's security posture; these tests count the commands of the flow under test.
  invoke: (...args: unknown[]) => (args[0] === "get_security_posture" ? Promise.resolve(undefined) : invokeMock(...args)),
}));

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/codex-rules.md" },
  { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", target_rel: ".claude/CLAUDE.md", source_rel: "templates/claude-rules.md" },
  { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", target_rel: ".claude/agents", source_rel: "templates/claude/agents" },
];

const CLAUDE_HEALTH: ClaudeRuntimeHealth = {
  rules_synced: true,
  agents_synced: true,
  skills_synced: true,
  expected_agent_count: 6,
  installed_agent_count: 6,
  claude_cli_available: true,
  summary: "Claude CLI available",
};

function codexHealth(checks: CodexRuntimeHealth["checks"] = []): CodexRuntimeHealth {
  return {
    status: "synced",
    rules_status: "synced",
    skills_status: "synced",
    skills_synced_count: 1,
    skills_expected_count: 1,
    agents_status: "synced",
    bundled_agent_count: 1,
    installed_bundled_agent_count: 1,
    config_status: "manual",
    approval_policy: null,
    sandbox_mode: null,
    checks,
    warnings: [],
    summary: "ok",
    next_action: "",
  } as unknown as CodexRuntimeHealth;
}

const OVERRIDE_CHECK = {
  id: "rules_override",
  label: "AGENTS.override.md replaces AGENTS.md",
  status: "warn",
  detail: "/Users/me/.codex/AGENTS.override.md exists and replaces AGENTS.md; the Riggverk base block is not loaded until it is removed or emptied",
};

function rules(overrides: Partial<RulesStatus> = {}): RulesStatus {
  return { layout: "block", refinement_lines: 0, user_managed: false, ...overrides };
}

function overviewWithRules(
  surface: SetupSurfaceId,
  harness: "claude" | "codex",
  state: InstallationState,
  status: RulesStatus,
  detail?: string,
) {
  const counts = state === "conflict" ? { conflict_count: 1 } : state === "update_available" ? { update_count: 1 } : {};
  return overviewOf({
    [harness]: installationStatus(state, [{ ...surfaceStatus(surface, state, detail), rules: status }], counts),
  });
}

function taskRunner() {
  const logs: ActionResult[] = [];
  const runWorkspaceTask = vi.fn(async (options: { task: () => Promise<unknown>; toActionResult: (r: never) => ActionResult; refresh?: () => unknown }) => {
    const result = await options.task();
    logs.push(options.toActionResult(result as never));
    await options.refresh?.();
    return result;
  });
  return { runWorkspaceTask: runWorkspaceTask as unknown as HarnessViewProps["runWorkspaceTask"], mock: runWorkspaceTask, logs };
}

function props(overrides: Partial<HarnessViewProps> = {}): HarnessViewProps & { tasks: ReturnType<typeof taskRunner> } {
  const tasks = taskRunner();
  return {
    appSettings: settingsOf(),
    agentTargets: TARGETS,
    settingsSaveStatus: "saved",
    onToggleTarget: vi.fn(),
    skillLoads: skillLoadsOf(),
    overview: overviewOf({}),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRefresh: vi.fn(),
    runWorkspaceTask: tasks.runWorkspaceTask,
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    dataFolderOk: true,
    ...overrides,
    tasks,
  };
}

const EDITS_DIFF: RulesDiffView = {
  surface: "claude_rules",
  mode: "edits",
  from_label: "shipped base sha256:0123456789abcd",
  to_label: "installed",
  applicable: true,
  note: "compared with the closest shipped base (2 lines differ)",
  compared_base: "sha256:0123456789abcdef",
  added: 1,
  removed: 1,
  truncated: false,
  diff: [
    "--- shipped base sha256:0123456789abcd",
    "+++ installed",
    "@@ -1,3 +1,3 @@",
    " # Global Agent Rules",
    "-Respond in the user's language.",
    "+Respond in Swedish.",
    " ## Security",
    "",
  ].join("\n"),
};

const UPDATE_DIFF: RulesDiffView = {
  ...EDITS_DIFF,
  mode: "update",
  from_label: "installed",
  to_label: "after update",
  note: null,
  compared_base: null,
  added: 2,
  removed: 0,
  diff: ["--- installed", "+++ after update", "@@ -1,1 +1,3 @@", " # Global Agent Rules", "+## Verification", "+Run the lightest falsifying check.", ""].join("\n"),
};

const RESULT_FILE = [
  "<!-- BEGIN RIGGVERK BASE: managed by Riggverk -->",
  "# Global Agent Rules",
  "<!-- END RIGGVERK BASE -->",
  "",
  "## Communication",
  "Respond in Swedish.",
  "",
].join("\n");

const PREVIEW: RulesConversionPreview = {
  surface: "claude_rules",
  applicable: true,
  reason: null,
  origin: "edited_block",
  compared_base: "sha256:0123456789abcdef",
  compared_base_changed_lines: 2,
  moved_sections: ["## Communication"],
  removed_sections: ["## Verification"],
  result: RESULT_FILE,
  diff: ["--- installed", "+++ after conversion", "@@ -1,2 +1,6 @@", "-Respond in the user's language.", "+Respond in Swedish.", ""].join("\n"),
  diff_truncated: false,
  plan_fingerprint: "fp-rules-1234567890",
  preview_token: "tok-rules-1",
};

const APPLY_RESULT: SetupResult = {
  success: true,
  transaction_id: "tx-rules-1",
  applied: ["~/.claude/CLAUDE.md"],
  failed: [],
  rolled_back: [],
  manual_steps: [],
  message: "applied 1 · preserved 0 · failed 0 · transaction tx-rules-1 recorded",
};

function backend(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = overrides[command];
    if (handler) return handler(args);
    switch (command) {
      case "preview_rules_diff":
        return args.mode === "update" ? UPDATE_DIFF : EDITS_DIFF;
      case "preview_rules_conversion":
        return PREVIEW;
      case "apply_rules_conversion":
        return APPLY_RESULT;
      case "set_rules_user_managed":
        return null;
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
}

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  invokeMock.mockReset();
  // jsdom has no native modal dialog; emulate open/close and the `close` event browsers fire.
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

function renderClaude(status: RulesStatus, state: InstallationState = "conflict", overrides: Partial<HarnessViewProps> = {}) {
  const p = props({ overview: overviewWithRules("claude_rules", "claude", state, status), ...overrides });
  return { p, ...renderInFrame(<ClaudeView {...p} runtimeHealth={CLAUDE_HEALTH} />) };
}

/** The page: the keys work with focus anywhere in it, and a click on it takes focus. */
function surfaces() {
  return screen.getByRole("region", { name: "Claude" });
}

function press(key: string) {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : surfaces();
  fireEvent.keyDown(target, { key });
}

function focusSurfaces() {
  act(() => surfaces().focus());
}

/** The cell of a surface (`claude_rules`, `claude_agents`). */
function cell(surface: string) {
  return surfaces().querySelector<HTMLElement>(`[data-surface="${surface}"]`)!;
}

/** The state pill of a cell: its words. */
function pill(surface: string) {
  return cell(surface).querySelector(".state-pill")!;
}

function rulesFile() {
  return screen.getByLabelText("Rules file");
}

function detailPane() {
  return surfaces();
}

function keyHints() {
  return within(screen.getByLabelText("Key hints"));
}

/** A key hint of the surfaces pane (or of the pane that has focus). Hints live as a key hint while their pane has focus. */
function surfaceHint(name: RegExp) {
  if (!surfaces().contains(document.activeElement)) focusSurfaces();
  return keyHints().queryByRole("button", { name });
}

function rulesPane() {
  return screen.getByRole("region", { name: "Rules review" });
}

describe("rules file in the detail pane", () => {
  it("shows layout and the refinement lines a base update keeps, as an update and not a conflict", () => {
    renderClaude(rules({ refinement_lines: 14 }), "update_available");
    expect(rulesFile().textContent).toContain("managed base block");
    expect(rulesFile().textContent).toContain("14 refinement lines preserved");
    expect(cell("claude_rules").textContent).toContain("can take the newest Riggverk rules");
    // A base update is "update ready", not a decision.
    expect(pill("claude_rules").textContent).toBe("Update ready");
    expect(cell("claude_rules").getAttribute("data-state")).toBe("ready");
    // A base update offers the diff only: nothing to convert, nothing to leave as is.
    expect(surfaceHint(/diff/)).not.toBeNull();
    expect(surfaceHint(/convert/)).toBeNull();
    expect(surfaceHint(/leave as is/)).toBeNull();
  });

  it("explains an edited base block as a conflict with its reason and offers diff, convert and leave as is", () => {
    renderClaude(rules({ conflict_reason: "base_block_edited", refinement_lines: 2 }));
    // The decision says why in a sentence and offers the three ways forward as buttons.
    expect(cell("claude_rules").textContent).toContain("Riggverk left CLAUDE.md exactly as it is, because its managed block was edited.");
    expect(cell("claude_rules").textContent).toContain("Claude reads your version and doesn't have the newest Riggverk rules yet.");
    expect(pill("claude_rules").textContent).toBe("Needs your decision");
    expect(cell("claude_rules").getAttribute("data-state")).toBe("decide");
    expect(surfaceHint(/diff/)).not.toBeNull();
    expect(surfaceHint(/convert/)).not.toBeNull();
    expect(surfaceHint(/leave as is/)).not.toBeNull();
  });

  it("explains a plain file that differs from every shipped base", () => {
    renderClaude(rules({ layout: "legacy", conflict_reason: "legacy_diverged" }));
    expect(cell("claude_rules").textContent).toContain("it matches none of the versions Riggverk ships");
    expect(surfaceHint(/convert/)).not.toBeNull();
  });

  it("names the marker rule that failed and offers neither conversion nor leave as is", () => {
    renderClaude(rules({ layout: "malformed", conflict_reason: "malformed_markers", malformed_reason: "duplicate_begin" }));
    expect(rulesFile().textContent).toContain("base block markers malformed");
    expect(rulesFile().textContent).toContain("more than one BEGIN marker");
    // Nothing in the app can fix it, so this is the one case that says what to do.
    expect(cell("claude_rules").textContent).toContain("Riggverk cannot split, so it never rewrites the file. Fix the markers by hand");
    expect(surfaceHint(/convert/)?.getAttribute("title")).toContain("malformed");
    expect(surfaceHint(/diff/)?.getAttribute("title")).toContain("malformed");
    expect(surfaceHint(/leave as is/)).toBeNull();
    focusSurfaces();
    press("v");
    press("d");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows a file the user manages as base updates available, not as a red conflict", () => {
    renderClaude(rules({ conflict_reason: "base_block_edited", user_managed: true }), "current");
    expect(cell("claude_rules").textContent).toContain("You manage CLAUDE.md, so Riggverk never writes it.");
    // Yours, not a decision and not a failure.
    expect(pill("claude_rules").textContent).toBe("Yours");
    expect(cell("claude_rules").getAttribute("data-state")).toBe("yours");
    expect(surfaceHint(/hand back/)).not.toBeNull();
    expect(surfaceHint(/leave as is/)).toBeNull();
  });

  it("leaves what to do about the file to the key hints: no instructions under the facts", () => {
    renderClaude(rules({ conflict_reason: "base_block_edited", refinement_lines: 2 }));
    expect(detailPane().textContent).not.toMatch(/An update replaces|Update skips this file|Base updates are not applied/);
    expect(detailPane().textContent).not.toContain("Fix the markers");
    // The rules summary says it all: the backend's one-line detail is not repeated above it.
    expect(detailPane().textContent).not.toContain("conflict detail");
    cleanup();
    renderClaude(rules({ refinement_lines: 14 }), "update_available");
    expect(detailPane().textContent).not.toMatch(/An update replaces/);
  });

  it("offers d, v and m only while the rules cell is the active one", () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    const offered = () => ["diff", "convert", "leave as is"].map(name => keyHints().queryByRole("button", { name: new RegExp(name) }) !== null);

    // The decision is the active cell until another is clicked: the keys are on offer with focus on the page or inside the cell.
    focusSurfaces();
    expect(offered()).toEqual([true, true, true]);
    act(() => within(cell("claude_rules")).getByRole("button", { name: /compare/i }).focus());
    expect(offered()).toEqual([true, true, true]);

    // A click in the agents cell makes it the active one: nothing to diff, convert or leave there, and the keys do nothing.
    fireEvent.click(cell("claude_agents"));
    expect(offered()).toEqual([false, false, false]);
    press("d");
    press("v");
    press("m");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Claude rules review" })).toBeNull();

    // Back in the rules cell they are on offer again.
    fireEvent.click(cell("claude_rules"));
    expect(offered()).toEqual([true, true, true]);
  });

  it("has a button for each action of the rules file, which does what its key does", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    const actions = within(cell("claude_rules"));
    expect(actions.getAllByRole("button").map(button => button.textContent?.replace(/^[a-z]/, "").trim())).toEqual(["Compare", "Merge in updates…", "Keep mine"]);
    fireEvent.click(actions.getByRole("button", { name: "Compare" }));
    await screen.findByRole("group", { name: /to installed/ });
    expect(invokeMock).toHaveBeenCalledWith("preview_rules_diff", { surface: "claude_rules", mode: "edits" });
    press("n");
    fireEvent.click(within(cell("claude_rules")).getByRole("button", { name: "Merge in updates…" }));
    await screen.findByLabelText("Conversion summary");
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_conversion", { surface: "claude_rules" });
  });

  it("asks first when Keep mine is clicked, and the button waits for a running task", async () => {
    backend();
    const { p, rerenderFrame } = renderClaude(rules({ conflict_reason: "base_block_edited" }));
    fireEvent.click(within(cell("claude_rules")).getByRole("button", { name: "Keep mine" }));
    const dialog = await screen.findByRole("dialog");
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invokeMock).not.toHaveBeenCalled();

    rerenderFrame(<ClaudeView {...p} wsRunning="update claude" runtimeHealth={CLAUDE_HEALTH} />);
    const keep = within(cell("claude_rules")).getByRole("button", { name: "Keep mine" });
    expect(keep.getAttribute("aria-disabled")).toBe("true");
    expect(keep.getAttribute("title")).toBe("update claude is running");
    fireEvent.click(keep);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no rules block for a surface that is not in the status, and no rules actions", () => {
    renderClaude(rules(), "current", { overview: overviewOf({}) });
    expect(screen.queryByLabelText("Rules file")).toBeNull();
    expect(surfaceHint(/diff/)).toBeNull();
  });

  it("disables the actions while another task runs", () => {
    renderClaude(rules({ conflict_reason: "base_block_edited" }), "conflict", { wsRunning: "update claude" });
    expect(surfaceHint(/convert/)?.getAttribute("title")).toBe("update claude is running");
    focusSurfaces();
    press("v");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

/** The Compare fold-out under the rules cell. */
function compareFold() {
  return screen.getByRole("group", { name: "Compare CLAUDE.md with Riggverk’s rules" });
}

function compareButton() {
  return within(cell("claude_rules")).getByRole("button", { name: /^(d\s*)?compare$/i });
}

describe("Compare (d), inline", () => {
  it("opens the update diff for a base update with exact args, read-only, with the page still in place", async () => {
    backend();
    renderClaude(rules({ refinement_lines: 14 }), "update_available");
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: "installed to after update" });
    // Compare never writes and needs no token: the one command it ran is the read-only diff.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("preview_rules_diff", { surface: "claude_rules", mode: "update" });
    // The page stays (inline), so no review replaces it and the cells and their keys are still there.
    expect(screen.getByRole("region", { name: "Claude" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Claude rules review" })).toBeNull();
    // Added lines carry a + in their own column, on the right; the diff has no way to write.
    const fold = compareFold();
    const added = Array.from(fold.querySelectorAll(".diff-line.add")).map(row => [row.querySelector(".diff-mark")!.textContent, row.querySelector(".diff-text")!.textContent]);
    expect(added).toEqual([["+", "## Verification"], ["+", "Run the lightest falsifying check."]]);
    expect(fold.querySelector(".diff-split")).not.toBeNull();
    expect(fold.querySelector("input, textarea, [contenteditable]")).toBeNull();
    expect(screen.queryByRole("button", { name: /apply/ })).toBeNull();
    // A base update has nothing to convert or leave as is: no choice cards.
    expect(within(fold).queryByRole("group", { name: "Resolve CLAUDE.md" })).toBeNull();
  });

  it("opens your edits against the shipped base for a conflict, side by side, with + and - in their own column", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    fireEvent.click(surfaceHint(/diff/)!);
    await screen.findByRole("group", { name: "shipped base sha256:0123456789abcd to installed" });
    expect(invokeMock).toHaveBeenCalledWith("preview_rules_diff", { surface: "claude_rules", mode: "edits" });
    const fold = compareFold();
    expect(fold.querySelector(".diff-row .diff-line.remove .diff-mark")!.textContent).toBe("-");
    expect(fold.querySelector(".diff-row .diff-line.remove .diff-text")!.textContent).toBe("Respond in the user's language.");
    expect(fold.querySelector(".diff-row .diff-line.add .diff-mark")!.textContent).toBe("+");
    expect(fold.textContent).toContain("compared with the closest shipped base (2 lines differ)");
  });

  it("is a toggle: aria-expanded and aria-controls follow it, and d, the button and Escape close it", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    expect(compareButton().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(compareButton());
    await screen.findByRole("group", { name: /to installed/ });
    expect(compareButton().getAttribute("aria-expanded")).toBe("true");
    expect(compareButton().getAttribute("aria-controls")).toBe(compareFold().id);
    // The button closes it again.
    fireEvent.click(compareButton());
    expect(screen.queryByRole("group", { name: "Compare CLAUDE.md with Riggverk’s rules" })).toBeNull();
    expect(compareButton().getAttribute("aria-expanded")).toBe("false");
    // d opens and closes it.
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    press("d");
    expect(screen.queryByRole("group", { name: "Compare CLAUDE.md with Riggverk’s rules" })).toBeNull();
    // Escape closes it from anywhere.
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Compare CLAUDE.md with Riggverk’s rules" })).toBeNull();
    expect(compareButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("switches between your edits and the update from the fold-out", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    fireEvent.click(within(compareFold()).getByRole("button", { name: "Show the update instead" }));
    await screen.findByRole("group", { name: "installed to after update" });
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_diff", { surface: "claude_rules", mode: "update" });
    fireEvent.click(within(compareFold()).getByRole("button", { name: "Show my edits instead" }));
    await screen.findByRole("group", { name: /to installed/ });
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_diff", { surface: "claude_rules", mode: "edits" });
  });

  it("offers the two ways out as cards with what is promised, and Merge in updates opens the preview of the exact file", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited", refinement_lines: 2 }));
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    const cards = within(compareFold()).getByRole("group", { name: "Resolve CLAUDE.md" });
    expect(within(cards).getAllByRole("button").map(card => card.querySelector(".hp-choice-t")!.firstChild!.textContent)).toEqual(["Merge in updates", "Keep mine"]);
    expect(compareFold().querySelector(".hp-conseq")!.textContent).toBe("Preview of the exact file firstBacked upUndo any time");
    // Merging writes nothing: it opens the conversion review, where only y applies.
    fireEvent.click(within(cards).getByRole("button", { name: /Merge in updates/ }));
    await screen.findByLabelText("Conversion summary");
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_conversion", { surface: "claude_rules" });
    expect(invokeMock).not.toHaveBeenCalledWith("apply_rules_conversion", expect.anything());
    expect(screen.getByRole("region", { name: "Claude rules review" })).toBeTruthy();
  });

  it("asks first when the Keep mine card is chosen", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    fireEvent.click(within(within(compareFold()).getByRole("group", { name: "Resolve CLAUDE.md" })).getByRole("button", { name: /Keep mine/ }));
    const dialog = await screen.findByRole("dialog");
    expect(invokeMock).not.toHaveBeenCalledWith("set_rules_user_managed", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "leave as is" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_rules_user_managed", { surface: "claude_rules", userManaged: true }));
  });

  it("says so when nothing differs", async () => {
    backend({ preview_rules_diff: () => ({ ...EDITS_DIFF, diff: "", added: 0, removed: 0, note: "matches a shipped base exactly; nothing was edited" }) });
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    expect((await screen.findByText("No differences from the shipped base.")).tagName).toBe("P");
  });

  it("shows the cut at 64 KB and the backend's note, as the review did", async () => {
    backend({ preview_rules_diff: () => ({ ...EDITS_DIFF, truncated: true }) });
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    expect(compareFold().textContent).toContain("The diff is cut at 64 KB; the rest is not shown.");
  });

  it("shows a failed preview inline with a way to try again, and nothing was written", async () => {
    let attempts = 0;
    backend({
      preview_rules_diff: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("rules file is not valid UTF-8");
        return EDITS_DIFF;
      },
    });
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    expect((await screen.findByRole("alert")).textContent).toContain("rules file is not valid UTF-8");
    expect(compareFold().textContent).toContain("Nothing was written.");
    fireEvent.click(within(compareFold()).getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: /to installed/ });
    expect(attempts).toBe(2);
  });

  it("keeps the other keys working while it is open: v previews the conversion in its place", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    press("v");
    await screen.findByLabelText("Conversion summary");
    expect(screen.queryByRole("group", { name: "Compare CLAUDE.md with Riggverk’s rules" })).toBeNull();
  });
});

describe("rules conversion (v, y)", () => {
  async function openPreview() {
    backend();
    const rendered = renderClaude(rules({ conflict_reason: "base_block_edited", refinement_lines: 2 }));
    focusSurfaces();
    press("v");
    await screen.findByLabelText("Conversion summary");
    return rendered;
  }

  it("previews the sections that move, the ones that return, the diff and the exact resulting file", async () => {
    await openPreview();
    expect(invokeMock).toHaveBeenCalledWith("preview_rules_conversion", { surface: "claude_rules" });
    expect(rulesPane()).toBeTruthy();
    const summary = screen.getByLabelText("Conversion summary").textContent!;
    expect(summary).toContain("a managed base block that was edited");
    expect(summary).toContain("1 section below the END marker: ## Communication");
    expect(summary).toContain("1 base section your file lacked: ## Verification");
    expect(summary).toContain("2 changed lines");
    // The diff comes first; `f` switches to the exact file apply writes.
    expect(rulesPane().querySelector(".diff-line.add .diff-text")!.textContent).toBe("Respond in Swedish.");
    // `f` belongs to the review pane: on a slow runner focus lands there a tick after the preview renders.
    await waitFor(() => expect(rulesPane().contains(document.activeElement)).toBe(true));
    press("f");
    expect((await screen.findByLabelText("Resulting file")).textContent).toBe(RESULT_FILE);
    press("f");
    await waitFor(() => expect(rulesPane().querySelector(".rules-file")).toBeNull());
  });

  it("applies with exactly the preview's fingerprint and token on y, and reports into the output with the transaction", async () => {
    const { p } = await openPreview();
    press("y");
    await waitFor(() => expect(p.onApplied).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenLastCalledWith("apply_rules_conversion", {
      surface: "claude_rules",
      planFingerprint: "fp-rules-1234567890",
      previewToken: "tok-rules-1",
    });
    expect(p.onApplied).toHaveBeenCalledWith(APPLY_RESULT);
    expect(p.tasks.mock).toHaveBeenCalledTimes(1);
    expect(p.tasks.mock.mock.calls[0]![0]).toMatchObject({ label: "convert claude rules", action: "apply_rules_conversion" });
    await waitFor(() => expect(p.refreshAfterApply).toHaveBeenCalledTimes(1));
    const log = p.tasks.logs[0]!;
    expect(log).toMatchObject({ success: true, action: "apply_rules_conversion claude rules", exit_code: 0 });
    expect(log.stdout).toContain("applied      claude rules");
    expect(log.stdout).toContain("kept         1 section below the END marker: ## Communication");
    expect(log.stdout).toContain("transaction tx-rules-1 recorded · rollback available");
    // The review closes and the page's panes come back (after the apply settles; a loaded run can lag a tick).
    expect(await screen.findByRole("region", { name: "Claude" })).toBeTruthy();
  });

  it("never applies on Enter, and y is also a button", async () => {
    const { p } = await openPreview();
    press("Enter");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_rules_conversion", expect.anything());
    // The review pane's hints reach the key hints once it has focus, which lags a tick on a loaded runner.
    fireEvent.click(await keyHints().findByRole("button", { name: /apply/ }));
    await waitFor(() => expect(p.onApplied).toHaveBeenCalledTimes(1));
  });

  it("cancels with n and writes nothing", async () => {
    await openPreview();
    press("n");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_rules_conversion", expect.anything());
    expect(surfaces()).toBeTruthy();
  });

  it("opens from the diff with v", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("d");
    await screen.findByRole("group", { name: /to installed/ });
    press("v");
    await screen.findByLabelText("Conversion summary");
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_conversion", { surface: "claude_rules" });
  });

  it("keeps a rejected apply (stale fingerprint) in the review, reports it in the output, and previews again on r", async () => {
    let previews = 0;
    backend({
      preview_rules_conversion: () => ({ ...PREVIEW, preview_token: `tok-${++previews}` }),
      apply_rules_conversion: () => {
        throw new Error("Plan fingerprint mismatch: the file changed after preview. Re-run preview before applying.");
      },
    });
    const { p } = renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("v");
    await screen.findByLabelText("Conversion summary");
    press("y");
    expect((await screen.findByRole("alert")).textContent).toContain("Plan fingerprint mismatch");
    expect(p.onApplied).not.toHaveBeenCalled();
    expect(p.tasks.logs[0]).toMatchObject({ success: false, action: "apply_rules_conversion claude rules" });
    expect(p.tasks.logs[0]!.stderr).toContain("Plan fingerprint mismatch");
    press("r");
    await screen.findByLabelText("Conversion summary");
    expect(previews).toBe(2);
  });

  it("offers no apply when there is nothing to convert", async () => {
    backend({
      preview_rules_conversion: () => ({
        ...PREVIEW,
        applicable: false,
        reason: "this file is managed by the base block already; use the regular update",
        origin: null,
        result: "",
        diff: "",
        plan_fingerprint: null,
        preview_token: null,
      }),
    });
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("v");
    expect((await screen.findByRole("alert")).textContent).toContain("nothing to convert: this file is managed by the base block already");
    expect(keyHints().queryByRole("button", { name: /apply/ })).toBeNull();
    press("y");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_rules_conversion", expect.anything());
  });

  it("waits for a running task before it applies", async () => {
    const { p, rerenderFrame } = await openPreview();
    rerenderFrame(<ClaudeView {...p} wsRunning="uninstall" runtimeHealth={CLAUDE_HEALTH} />);
    const apply = keyHints().getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("title")).toBe("uninstall is running");
    press("y");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_rules_conversion", expect.anything());
  });

  it("gives way to the install review when it opens", async () => {
    const { p, rerenderFrame } = await openPreview();
    const install = installScreenOf(flowOf([op("claude_rules", "update")], { label: "update claude", surfaces: ["claude_rules"] }), "claude");
    rerenderFrame(<ClaudeView {...p} install={install} runtimeHealth={CLAUDE_HEALTH} />);
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Rules review" })).toBeNull();
  });
});

describe("leave as is (m)", () => {
  it("asks first, then records the choice with exact args and reloads the status", async () => {
    backend();
    const { p } = renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("m");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("CLAUDE.md");
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "leave as is" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_rules_user_managed", { surface: "claude_rules", userManaged: true }));
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
  });

  it("writes nothing when the confirm is declined", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "legacy_diverged", layout: "legacy" }));
    focusSurfaces();
    press("m");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("hands a left-as-is file back to the app at once, without a confirm", async () => {
    backend();
    const { p } = renderClaude(rules({ conflict_reason: "base_block_edited", user_managed: true }), "current");
    focusSurfaces();
    press("m");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_rules_user_managed", { surface: "claude_rules", userManaged: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
  });

  it("shows why the backend refused", async () => {
    backend({
      set_rules_user_managed: () => {
        throw new Error("this file is not a conflict; there is nothing to leave as is");
      },
    });
    renderClaude(rules({ conflict_reason: "base_block_edited", user_managed: true }), "current");
    focusSurfaces();
    press("m");
    expect((await screen.findByRole("alert")).textContent).toContain("nothing to leave as is");
  });
});

describe(":rules command", () => {
  function run(line: string) {
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: line } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("diff, convert and leave do what the keys do", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    run("rules diff claude");
    await screen.findByRole("group", { name: /to installed/ });
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_diff", { surface: "claude_rules", mode: "edits" });
    press("n");

    run("rules convert claude");
    await screen.findByLabelText("Conversion summary");
    expect(invokeMock).toHaveBeenLastCalledWith("preview_rules_conversion", { surface: "claude_rules" });
    press("n");

    run("rules leave claude");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "leave as is" }));
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("set_rules_user_managed", { surface: "claude_rules", userManaged: true }));
  });

  it("manage hands a left-as-is file back", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited", user_managed: true }), "current");
    run("rules manage claude");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_rules_user_managed", { surface: "claude_rules", userManaged: false }));
  });

  it("explains why a command cannot run, and that another harness' rules act from its own page", () => {
    backend();
    renderClaude(rules({ refinement_lines: 3 }), "update_available");
    run("rules convert claude");
    expect(screen.getByRole("alert").textContent).toContain("rules convert: the file is not a conflict; there is nothing to convert");
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });

    run("rules diff codex");
    expect(screen.getByRole("alert").textContent).toContain("Codex rules act from the Codex page; open it first (:codex)");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("works whichever row the cursor is on", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    focusSurfaces();
    press("j");
    run("rules diff claude");
    await screen.findByRole("group", { name: /to installed/ });
  });

  it("defaults to the harness of the page when none is named", async () => {
    backend();
    renderClaude(rules({ conflict_reason: "base_block_edited" }));
    run("rules diff");
    await screen.findByRole("group", { name: /to installed/ });
  });
});

describe("Codex rules override", () => {
  function renderCodex(health: CodexRuntimeHealth) {
    const p = props({ overview: overviewWithRules("codex_rules", "codex", "current", rules()) });
    return renderInFrame(<CodexView {...p} runtimeHealth={health} />);
  }

  it("warns prominently that AGENTS.override.md replaces AGENTS.md", () => {
    renderCodex(codexHealth([OVERRIDE_CHECK]));
    const alert = within(screen.getByRole("region", { name: "Codex" })).getByRole("alert");
    expect(alert.textContent).toContain("AGENTS.override.md replaces AGENTS.md");
    expect(alert.textContent).toContain("the Riggverk base block is not loaded until it is removed or emptied");
    expect(alert.className).toContain("hp-alert");
  });

  it("stays quiet without the warning", () => {
    renderCodex(codexHealth([{ ...OVERRIDE_CHECK, status: "pass" }]));
    expect(within(screen.getByRole("region", { name: "Codex" })).queryByRole("alert")).toBeNull();
    cleanup();
    renderCodex(codexHealth([]));
    expect(within(screen.getByRole("region", { name: "Codex" })).queryByRole("alert")).toBeNull();
  });
});

describe("Cursor", () => {
  it("has no rules file: no rules block and no rules actions", () => {
    const p = props({
      overview: overviewOf({ cursor: installationStatus("current", [surfaceStatus("cursor_agents", "current")]) }),
      agentTargets: [{ id: "cursor_setup", label: "cursor setup", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "templates/cursor/agents" }],
    });
    renderInFrame(<CursorView {...p} runtimeHealth={null} />);
    expect(screen.queryByLabelText("Rules file")).toBeNull();
    act(() => screen.getByRole("region", { name: "Cursor" }).focus());
    expect(keyHints().queryByRole("button", { name: /diff|convert|leave/ })).toBeNull();
  });
});
