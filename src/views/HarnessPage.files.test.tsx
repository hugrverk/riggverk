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
  STATUS_DATA,
  surfaceStatus,
} from "../test/pageFixtures";
import type {
  ActionResult,
  AgentTargetMeta,
  ClaudeRuntimeHealth,
  FileDiffEntry,
  FileDiffView,
  FilesStatus,
  FileUnit,
  FileUnitFile,
  RulesStatus,
} from "../types";
import { ClaudeView } from "./ClaudeView";
import type { HarnessViewProps } from "./pageTypes";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const TARGETS: AgentTargetMeta[] = [
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

const FAKE_GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function file(rel: string, state: FileUnitFile["state"] = "conflict", bundleChanged = false): FileUnitFile {
  return { rel, state, reason: "edited", bundle_changed: bundleChanged };
}

function unit(overrides: Partial<FileUnit> = {}): FileUnit {
  return {
    key: "skill:claude:tdd",
    kind: "skill",
    name: "tdd",
    folder: "~/.claude/skills",
    wanted: true,
    state: "conflict",
    reason: "edited",
    bundle_changed: false,
    read_by: ["Claude", "OpenCode"],
    files: [file("SKILL.md")],
    more_files: 0,
    ...overrides,
  };
}

const TDD = unit();
const AUDIT = unit({
  key: "skill:agents:security-audit",
  name: "security-audit",
  folder: "~/.agents/skills",
  reason: "unproven",
  read_by: ["Codex", "OpenCode"],
  files: [file("HUNTING.md"), file("CLIENT-SIDE.md"), file("assets/report.bin")],
});
const DIAGNOSE = unit({
  key: "skill:claude:diagnose",
  name: "diagnose",
  state: "kept",
  bundle_changed: true,
  files: [file("SKILL.md", "kept", true)],
});
const VERIFIER = unit({
  key: "agent:verifier",
  kind: "agent",
  name: "verifier",
  folder: "~/.claude/agents",
  read_by: ["Claude"],
  files: [file("verifier.md")],
});

function filesOf(units: FileUnit[]): FilesStatus {
  const all = units.flatMap(candidate => candidate.files);
  return {
    conflicts: all.filter(candidate => candidate.state === "conflict").length,
    kept: all.filter(candidate => candidate.state === "kept").length,
    kept_updates: all.filter(candidate => candidate.state === "kept" && candidate.bundle_changed).length,
    units,
    more: 0,
  };
}

function rules(overrides: Partial<RulesStatus> = {}): RulesStatus {
  return { layout: "block", refinement_lines: 0, user_managed: false, ...overrides };
}

interface Seed {
  skills?: FileUnit[];
  agents?: FileUnit[];
  rules?: RulesStatus;
}

function overviewWith({ skills = [], agents = [], rules: rulesStatus = rules() }: Seed) {
  const skillFiles = filesOf(skills);
  const agentFiles = filesOf(agents);
  const conflicts = skillFiles.conflicts + agentFiles.conflicts + (rulesStatus.conflict_reason ? 1 : 0);
  const kept = skillFiles.kept + agentFiles.kept;
  return overviewOf({
    claude: installationStatus(
      conflicts > 0 ? "conflict" : "current",
      [
        { ...surfaceStatus("claude_rules", rulesStatus.conflict_reason ? "conflict" : "current"), rules: rulesStatus },
        { ...surfaceStatus("claude_agents", agentFiles.conflicts > 0 ? "conflict" : "current"), ...(agents.length > 0 ? { files: agentFiles } : {}) },
        { ...surfaceStatus("skills", skillFiles.conflicts > 0 ? "conflict" : "current"), ...(skills.length > 0 ? { files: skillFiles } : {}) },
      ],
      { conflict_count: conflicts, kept_count: kept },
    ),
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
    onRollback: vi.fn(),
    onRefresh: vi.fn(),
    runWorkspaceTask: tasks.runWorkspaceTask,
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    onClearOutput: vi.fn(),
    ...overrides,
    tasks,
  };
}

function entry(rel: string, overrides: Partial<FileDiffEntry> = {}): FileDiffEntry {
  return {
    rel,
    state: "conflict",
    kind: "text",
    from_label: "yours",
    to_label: "bundled",
    installed: { bytes: 120, digest: "sha256:0123456789ab" },
    bundled: { bytes: 118, digest: "sha256:ba9876543210" },
    note: null,
    added: 1,
    removed: 1,
    truncated: false,
    diff: ["--- yours", "+++ bundled", "@@ -1,3 +1,3 @@", " # Title", "-Write the failing test first.", `+Write one failing test. token ${FAKE_GH}`, " Keep it small.", ""].join("\n"),
    ...overrides,
  };
}

function view(name: string, files: FileDiffEntry[], overrides: Partial<FileDiffView> = {}): FileDiffView {
  return { name, folder: "~/.claude/skills", files, more_files: 0, truncated: false, ...overrides };
}

function backend(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = overrides[command];
    if (handler) return handler(args);
    switch (command) {
      case "preview_file_diff":
        return view(String(args.unit).split(":").pop()!, [entry("SKILL.md")]);
      case "set_files_kept":
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

function renderClaude(seed: Seed, overrides: Partial<HarnessViewProps> = {}) {
  const p = props({ overview: overviewWith(seed), ...overrides });
  return { p, ...renderInFrame(<ClaudeView {...p} runtimeHealth={CLAUDE_HEALTH} />) };
}

function surfaces() {
  return screen.getByRole("listbox", { name: "Claude surfaces" });
}

function press(key: string) {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : surfaces();
  fireEvent.keyDown(target, { key });
}

function focusSurfaces() {
  act(() => surfaces().focus());
}

/** A row of the surfaces list by its name: the `[x]` toggle in front of it is not part of the name. */
function surfaceRow(name: string) {
  return within(surfaces()).getAllByRole("option").find(row => new RegExp(`^(\\[.\\] )?${name}\\b`).test(row.querySelector(".nm")!.textContent!.trim()))!;
}

/** Puts the cursor on a row (a click selects, it does not toggle) and the keyboard on the list. */
function moveTo(name: string) {
  fireEvent.click(surfaceRow(name));
  focusSurfaces();
}

function detailPane() {
  return screen.getByRole("region", { name: "Claude detail" });
}

function fileLines() {
  return screen.queryByLabelText("Files in conflict or kept");
}

function statusBar() {
  return within(screen.getByLabelText("Status bar"));
}

function hint(name: RegExp) {
  if (!screen.getByRole("region", { name: "Claude surfaces" }).contains(document.activeElement)) focusSurfaces();
  return statusBar().queryByRole("button", { name });
}

function mode() {
  return document.querySelector(".statusbar .mode")!.textContent;
}

function review() {
  return screen.getByRole("region", { name: "Conflict review" });
}

describe("skill and agent files in the detail pane", () => {
  it("lists each skill with where it is, how many files, why, and who reads it, and marks the first", () => {
    renderClaude({ skills: [TDD, AUDIT, DIAGNOSE] });
    moveTo("skills");
    const lines = fileLines()!.textContent!;
    expect(lines).toContain("tdd · ~/.claude/skills · SKILL.md · edited since Riggverk wrote it · read by Claude, OpenCode");
    expect(lines).toContain("security-audit · ~/.agents/skills · HUNTING.md +2 files · not written by Riggverk (no record) · read by Codex, OpenCode");
    expect(lines).toContain("diagnose · ~/.claude/skills · SKILL.md · you manage · bundled update available");
    expect(Array.from(fileLines()!.querySelectorAll("dt")).map(dt => dt.textContent)).toEqual(["▸", " ", " "]);
    // The row says how many files need a look, and the old "preserved" list is not repeated for them.
    // Files count, not units: tdd has one file in conflict and security-audit three.
    expect(surfaceRow("skills").querySelector(".meta")!.textContent).toContain("4 conflicts");
    expect(surfaceRow("skills").querySelector(".meta")!.textContent).toContain("you manage 1");
    expect(detailPane().textContent).not.toContain("preserved");
  });

  it("tells an agent in conflict and one the user keeps on the agents row", () => {
    renderClaude({ agents: [VERIFIER, unit({ key: "agent:sentinel", kind: "agent", name: "sentinel", folder: "~/.claude/agents", state: "kept", files: [file("sentinel.md", "kept")] })] });
    moveTo("agents");
    expect(fileLines()!.textContent).toContain("verifier · ~/.claude/agents · edited since Riggverk wrote it");
    expect(fileLines()!.textContent).toContain("sentinel · ~/.claude/agents · you manage · bundle unchanged");
    expect(surfaceRow("agents").querySelector(".meta")!.textContent).toContain("1 conflict");
  });

  it("shows a surface that is otherwise current with the files the user keeps as a warning, not as current", () => {
    renderClaude({ skills: [DIAGNOSE] });
    const meta = surfaceRow("skills").querySelector(".meta")!;
    expect(meta.textContent).toBe("you manage 1");
    expect(meta.className).toContain("c-warn");
    expect(meta.className).not.toContain("c-fail");
  });

  it("shows no files block for a surface without files, or while the status has none", () => {
    renderClaude({});
    moveTo("skills");
    expect(fileLines()).toBeNull();
    expect(surfaceRow("skills").querySelector(".meta")!.textContent).toBe("current");
  });
});

describe("keys on the skills and agents rows", () => {
  it("offers c, d and m only on a skills or agents row with files, and leaves the rules keys to the rules row", () => {
    backend();
    renderClaude({ skills: [TDD, DIAGNOSE], rules: rules({ conflict_reason: "base_block_edited" }) });
    const offered = () => ["next conflict", "diff", "keep mine", "hand back", "convert"].map(name => hint(new RegExp(name)) !== null);

    // The rules row is first: d and m are the rules ones; c belongs to nobody.
    focusSurfaces();
    expect(offered()).toEqual([false, true, false, false, true]);
    expect(hint(/leave as is/)).not.toBeNull();

    moveTo("skills");
    expect(offered()).toEqual([true, true, true, false, false]);
    expect(hint(/leave as is/)).toBeNull();

    // The agents row has no files in this status.
    moveTo("agents");
    expect(offered()).toEqual([false, false, false, false, false]);
    press("d");
    press("c");
    press("m");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers c only with two units, and hand back instead of keep mine on a kept one", () => {
    backend();
    renderClaude({ skills: [DIAGNOSE] });
    moveTo("skills");
    expect(hint(/next conflict/)).toBeNull();
    expect(hint(/hand back/)).not.toBeNull();
    expect(hint(/keep mine/)).toBeNull();
  });

  it("c marks the next unit and wraps around, and the keys then act on it", async () => {
    backend();
    renderClaude({ skills: [TDD, AUDIT, DIAGNOSE] });
    moveTo("skills");
    const marked = () => Array.from(fileLines()!.querySelectorAll("dt")).findIndex(dt => dt.textContent === "▸");
    expect(marked()).toBe(0);
    press("c");
    expect(marked()).toBe(1);
    press("c");
    press("c");
    expect(marked()).toBe(0);
    press("c");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(invokeMock).toHaveBeenCalledWith("preview_file_diff", { surface: "skills", unit: "skill:agents:security-audit" });
  });

  it("disables the keys while another task runs", () => {
    backend();
    renderClaude({ skills: [TDD] }, { wsRunning: "update claude" });
    moveTo("skills");
    expect(hint(/keep mine/)?.getAttribute("title")).toBe("update claude is running");
    press("m");
    press("d");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("conflict diff (d)", () => {
  it("opens the diff of the marked unit with exact args, read-only, in CONFIRM mode", async () => {
    backend();
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(invokeMock).toHaveBeenCalledWith("preview_file_diff", { surface: "skills", unit: "skill:claude:tdd" });
    expect(mode()).toBe("CONFIRM");
    const pane = review();
    expect(pane.querySelector(".pane-title")!.textContent).toContain("tdd");
    expect(pane.querySelector(".pane-title")!.textContent).toContain("+1 −1");
    expect(pane.querySelector(".diff-line.remove .diff-text")!.textContent).toBe("Write the failing test first.");
    expect(pane.querySelector("input, textarea, [contenteditable]")).toBeNull();
    // The page's pair is replaced by one pane and the output strip, like the other reviews.
    expect(screen.queryByRole("listbox", { name: "Claude surfaces" })).toBeNull();
    expect(screen.getByRole("region", { name: "Claude conflict review" }).className).toContain("review");
    expect(screen.getByRole("region", { name: "Output" })).toBeTruthy();
    // Only the diff was asked for.
    expect(invokeMock.mock.calls.map(call => call[0])).toEqual(["preview_file_diff"]);
  });

  it("masks token shapes in the diff before they reach the screen", async () => {
    backend();
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(review().textContent).not.toContain(FAKE_GH);
    expect(review().textContent).toContain("Write one failing test. token [REDACTED]");
  });

  it("keeps words like session and token readable", async () => {
    backend({
      preview_file_diff: () =>
        view("tdd", [entry("SKILL.md", { diff: ["--- yours", "+++ bundled", "@@ -1,1 +1,2 @@", " session: kept per run", "+token: the bearer of the request", ""].join("\n") })]),
    });
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(review().textContent).toContain("session: kept per run");
    expect(review().textContent).toContain("token: the bearer of the request");
  });

  it("says what it cannot show without showing it: key material, binary, too large, line endings only", async () => {
    backend({
      preview_file_diff: () =>
        view("security-audit", [
          entry("scripts/deploy.sh", { kind: "withheld", note: "contains key material, not shown", diff: "", added: 0, removed: 0 }),
          entry("assets/report.bin", { kind: "binary", note: "not text; sizes and digests only", diff: "", added: 0, removed: 0 }),
          entry("big.md", { kind: "too_large", note: "too large to compare here; sizes and digests only", installed: { bytes: 600000, digest: "sha256:aaaaaaaaaaaa" }, diff: "", added: 0, removed: 0 }),
          entry("CLIENT-SIDE.md", { kind: "identical_text", note: "differs only in line endings or trailing bytes", diff: "", added: 0, removed: 0 }),
        ]),
    });
    renderClaude({ skills: [AUDIT] });
    moveTo("skills");
    press("d");
    await screen.findByText("contains key material, not shown");
    const text = review().textContent!;
    expect(text).toContain("not text; sizes and digests only");
    expect(text).toContain("too large to compare here");
    expect(text).toContain("600,000 bytes · sha256:aaaaaaaaaaaa");
    expect(text).toContain("differs only in line endings or trailing bytes");
    expect(review().querySelector(".diff")).toBeNull();
  });

  it("says when a diff is cut and when files are not shown", async () => {
    backend({
      preview_file_diff: () => view("tdd", [entry("SKILL.md", { truncated: true, note: null })], { truncated: true, more_files: 3 }),
    });
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(review().textContent).toContain("The diff of this file is cut at 64 KB");
    expect(review().textContent).toContain("3 more files of this unit not shown");
  });

  it("says so when nothing differs", async () => {
    backend({ preview_file_diff: () => view("tdd", [entry("SKILL.md", { diff: "", added: 0, removed: 0 })]) });
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    expect((await screen.findByText("no differences")).tagName).toBe("P");
  });

  it("n and Escape close it and bring the panes and the keyboard back", async () => {
    backend();
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    press("n");
    expect(screen.getByRole("listbox", { name: "Claude surfaces" })).toBeTruthy();
    expect(mode()).toBe("NORMAL");
    expect(document.activeElement).toBe(surfaces());
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Conflict review" })).toBeNull();
  });

  it("shows a failed diff with a way to try again", async () => {
    let attempts = 0;
    backend({
      preview_file_diff: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("this skill or agent has no conflicting or kept files right now");
        return view("tdd", [entry("SKILL.md")]);
      },
    });
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    expect((await screen.findByRole("alert")).textContent).toContain("has no conflicting or kept files right now");
    press("r");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(attempts).toBe(2);
  });

  it("[ and ] move between units, and the marked unit follows", async () => {
    backend();
    renderClaude({ skills: [TDD, AUDIT] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    press("]");
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("preview_file_diff", { surface: "skills", unit: "skill:agents:security-audit" }));
    await waitFor(() => expect(review().querySelector(".pane-title")!.textContent).toContain("security-audit"));
    press("[");
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("preview_file_diff", { surface: "skills", unit: "skill:claude:tdd" }));
    press("n");
    expect(Array.from(fileLines()!.querySelectorAll("dt")).map(dt => dt.textContent)).toEqual(["▸", " "]);
  });

  it("gives way to the install review when it opens", async () => {
    backend();
    const { p, rerenderFrame } = renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    const install = installScreenOf(flowOf([op("claude_rules", "update")], { label: "update claude", surfaces: ["claude_rules"] }), "claude");
    rerenderFrame(<ClaudeView {...p} install={install} runtimeHealth={CLAUDE_HEALTH} />);
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Conflict review" })).toBeNull();
  });
});

describe("keep mine and hand back (m)", () => {
  it("asks first, then records the choice with exact args and reloads the status and the skill loads", async () => {
    backend();
    const skillLoads = skillLoadsOf();
    const { p } = renderClaude({ skills: [TDD] }, { skillLoads });
    moveTo("skills");
    press("m");
    const dialog = await screen.findByRole("dialog");
    expect(mode()).toBe("CONFIRM");
    expect(dialog.textContent).toContain("Keep your version of tdd in ~/.claude/skills (1 file)?");
    expect(dialog.textContent).toContain("Riggverk stops proposing changes to it and never writes it");
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "keep mine" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_files_kept", { surface: "skills", units: ["skill:claude:tdd"], kept: true }));
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
    expect(skillLoads.refresh).toHaveBeenCalledTimes(1);
  });

  it("counts the files of a skill in the question and words an agent without them", async () => {
    backend();
    renderClaude({ skills: [AUDIT], agents: [VERIFIER] });
    moveTo("skills");
    press("m");
    let dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Keep your version of security-audit in ~/.agents/skills (3 files)?");
    expect(dialog.textContent).toContain("Other files of the skill keep updating");
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(mode()).toBe("NORMAL"));
    moveTo("agents");
    press("m");
    dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Keep your version of verifier in ~/.claude/agents?");
    expect(dialog.textContent).not.toContain("Other files of the skill");
  });

  it("writes nothing when the confirm is declined", async () => {
    backend();
    renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("m");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(mode()).toBe("NORMAL"));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("hands a kept unit back to the app at once, without a confirm", async () => {
    backend();
    const { p } = renderClaude({ skills: [DIAGNOSE] });
    moveTo("skills");
    press("m");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_files_kept", { surface: "skills", units: ["skill:claude:diagnose"], kept: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
  });

  it("shows why the backend refused", async () => {
    backend({
      set_files_kept: () => {
        throw new Error("setup operation already in progress");
      },
    });
    renderClaude({ skills: [DIAGNOSE] });
    moveTo("skills");
    press("m");
    expect((await screen.findByRole("alert")).textContent).toContain("setup operation already in progress");
  });

  it("works from inside the review too, and the review then offers the other action", async () => {
    backend();
    const { p, rerenderFrame } = renderClaude({ skills: [TDD] });
    moveTo("skills");
    press("d");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    await waitFor(() => expect(review().contains(document.activeElement)).toBe(true));
    // The review pane's hints reach the status bar once it has focus, which lags a tick on a loaded runner.
    expect(await statusBar().findByRole("button", { name: /keep mine/ })).toBeTruthy();
    press("m");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "keep mine" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_files_kept", { surface: "skills", units: ["skill:claude:tdd"], kept: true }));
    // The reloaded status says it is kept now: the same pane offers to hand it back, and says it keeps it.
    p.overview.entries.claude = overviewWith({ skills: [unit({ state: "kept", files: [file("SKILL.md", "kept")] })] }).entries.claude!;
    rerenderFrame(<ClaudeView {...p} runtimeHealth={CLAUDE_HEALTH} />);
    expect(await within(review()).findByRole("button", { name: /hand back/ })).toBeTruthy();
    expect(within(review()).queryByRole("button", { name: /keep mine/ })).toBeNull();
    expect(review().textContent).toContain("You keep your version: updates never write it");
    expect(review().textContent).toContain("SKILL.md · you manage");
  });
});

describe(":resolve command", () => {
  function run(line: string) {
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: line } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("diff opens the diff, and mine and manage do what m does", async () => {
    backend();
    renderClaude({ skills: [TDD, DIAGNOSE] });
    moveTo("skills");
    run("resolve diff tdd");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(invokeMock).toHaveBeenLastCalledWith("preview_file_diff", { surface: "skills", unit: "skill:claude:tdd" });
    press("n");

    run("resolve mine tdd");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "keep mine" }));
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("set_files_kept", { surface: "skills", units: ["skill:claude:tdd"], kept: true }));

    run("resolve manage diagnose");
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("set_files_kept", { surface: "skills", units: ["skill:claude:diagnose"], kept: false }));
  });

  it("defaults to the marked unit, and finds a unit on the other files surface by name", async () => {
    backend();
    renderClaude({ skills: [TDD, AUDIT], agents: [VERIFIER] });
    moveTo("skills");
    press("c");
    run("resolve diff");
    await screen.findByRole("group", { name: "SKILL.md: yours to bundled" });
    expect(invokeMock).toHaveBeenLastCalledWith("preview_file_diff", { surface: "skills", unit: "skill:agents:security-audit" });
    press("n");
    run("resolve diff verifier");
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("preview_file_diff", { surface: "claude_agents", unit: "agent:verifier" }));
  });

  it("explains why a command cannot run, in the same situations the keys cannot", () => {
    backend();
    renderClaude({ skills: [TDD, DIAGNOSE] });
    moveTo("skills");
    run("resolve manage tdd");
    expect(screen.getByRole("alert").textContent).toContain("resolve manage: tdd is not kept (:resolve mine keeps it)");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });

    run("resolve mine diagnose");
    expect(screen.getByRole("alert").textContent).toContain("resolve mine: diagnose is already kept (:resolve manage hands it back)");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });

    run("resolve diff nothing-here");
    expect(screen.getByRole("alert").textContent).toContain("resolve diff: no skill or agent named nothing-here is in conflict or kept here");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("asks which copy when a name is in several folders, and which row when none is under the cursor", () => {
    backend();
    renderClaude({ skills: [TDD, unit({ key: "skill:agents:tdd", folder: "~/.agents/skills" })] });
    moveTo("skills");
    run("resolve diff tdd");
    expect(screen.getByRole("alert").textContent).toContain("tdd has copies in several folders; mark one with c on the skills row");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });
    moveTo("rules");
    run("resolve diff");
    expect(screen.getByRole("alert").textContent).toContain("move the cursor to the skills or agents row, or name a skill or agent");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("is refused while a task runs, and says there is nothing to resolve on a page without files", () => {
    backend();
    renderClaude({ skills: [TDD] }, { wsRunning: "update claude" });
    moveTo("skills");
    run("resolve mine");
    expect(screen.getByRole("alert").textContent).toContain("resolve mine: update claude is running");
    expect(invokeMock).not.toHaveBeenCalled();
    cleanup();

    renderClaude({});
    run("resolve diff");
    expect(screen.getByRole("alert").textContent).toContain("there are no conflicting or kept skill or agent files on this page");
  });
});
