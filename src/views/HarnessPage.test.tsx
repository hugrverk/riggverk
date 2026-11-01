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
  CLEAN_CODEX,
  RISKY_CLAUDE,
} from "../test/pageFixtures";
import type { AgentTargetMeta, ClaudeRuntimeHealth, CodexRuntimeHealth, EffectiveSkillLoads, OpenCodeModelSelection, OpenCodeRuntimeHealth, SkillCopy } from "../types";
import { ClaudeView } from "./ClaudeView";
import { CodexView } from "./CodexView";
import { CursorView } from "./CursorView";
import { HarnessPage } from "./HarnessPage";
import { OpenCodeView } from "./OpenCodeView";
import type { HarnessViewProps } from "./pageTypes";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/codex-rules.md" },
  { id: "codex_agents", label: "codex agents", harness: "codex", kind: "agents", target_rel: ".codex/agents", source_rel: "templates/codex/agents" },
  { id: "codex_config", label: "codex config", harness: "codex", kind: "config", target_rel: ".codex/config.toml", source_rel: "templates/codex/config.toml" },
  { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", target_rel: ".claude/CLAUDE.md", source_rel: "templates/claude-rules.md" },
  { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", target_rel: ".claude/agents", source_rel: "templates/claude/agents" },
  { id: "claude_config", label: "claude config", harness: "claude", kind: "config", target_rel: ".claude/settings.json", source_rel: "" },
];

const CODEX_HEALTH = {
  status: "diverged",
  rules_status: "synced",
  skills_status: "synced",
  skills_synced_count: 17,
  skills_expected_count: 18,
  agents_status: "synced",
  bundled_agent_count: 6,
  installed_bundled_agent_count: 6,
  config_status: "missing",
  approval_policy: "on-request",
  sandbox_mode: "workspace-write",
  warnings: [],
  summary: "Codex diverged",
  next_action: "Update Codex.",
} as unknown as CodexRuntimeHealth;

const CLAUDE_HEALTH: ClaudeRuntimeHealth = {
  rules_synced: true,
  agents_synced: false,
  skills_synced: true,
  expected_agent_count: 6,
  installed_agent_count: 5,
  claude_cli_available: true,
  summary: "Claude CLI available",
};

function props(overrides: Partial<HarnessViewProps> = {}): HarnessViewProps {
  return {
    appSettings: settingsOf(),
    agentTargets: TARGETS,
    settingsSaveStatus: "saved",
    onToggleTarget: vi.fn(),
    skillLoads: skillLoadsOf(),
    overview: overviewOf({
      codex: installationStatus("update_available", [surfaceStatus("codex_rules", "update_available"), surfaceStatus("skills", "current")], { update_count: 1 }),
      claude: installationStatus("current", [surfaceStatus("claude_rules", "current")]),
    }),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRefresh: vi.fn(),
    runWorkspaceTask: vi.fn(async () => null) as unknown as HarnessViewProps["runWorkspaceTask"],
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    dataFolderOk: true,
    ...overrides,
  };
}

function renderCodex(overrides: Partial<HarnessViewProps> = {}) {
  const merged = props(overrides);
  return { props: merged, ...renderInFrame(<CodexView {...merged} runtimeHealth={CODEX_HEALTH} />) };
}

/** The page: the keys work with focus anywhere in it, and a click on it takes focus. */
function surfaces() {
  return screen.getByRole("region", { name: "Codex" });
}

function detail() {
  return surfaces();
}

function press(key: string, target: Element = surfaces()) {
  fireEvent.keyDown(target, { key });
}

function keyHints() {
  return within(screen.getByLabelText("Key hints"));
}

/** A key hint of the focused pane: hints live as a key hint, not in the panes. */
function hint(name: RegExp) {
  return keyHints().getByRole("button", { name });
}

/** The `dt` -> `dd` pairs of a page, runtime facts included. */
function facts(root: HTMLElement = detail()): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dt of root.querySelectorAll("dt")) result[dt.textContent!] = dt.nextElementSibling!.textContent!;
  return result;
}

/** The cells of a page in order: surface, the words of its pill, the state of its switch. */
function cells(root: HTMLElement = surfaces()) {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-surface]")).map(cell => [
    cell.dataset.surface,
    cell.querySelector(".state-pill")?.textContent ?? null,
    cell.querySelector('[role="switch"]')?.getAttribute("aria-checked") ?? null,
  ]);
}

function cell(surface: string, root: HTMLElement = surfaces()) {
  return root.querySelector<HTMLElement>(`[data-surface="${surface}"]`)!;
}

function runtime(root: HTMLElement = surfaces()) {
  return within(root).getByRole("region", { name: "Runtime" });
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe("HarnessPage", () => {
  it("shows the name with a mono line under it and a grid of cells, and leaves the run panel to the app frame", () => {
    renderCodex({ wsRunning: "update codex" });
    const page = surfaces();
    expect(within(page).getByRole("heading", { name: "Codex" }).tagName).toBe("H4");
    // Where it lives, how many skills it loads and what the runtime says, in one line.
    expect(page.querySelector(".hp-sub")!.textContent).toBe("~/.codex · approval on-request · sandbox workspace-write");
    expect(page.querySelector(".hp-grid")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Run" })).toBeNull();
  });

  it("is the page-level focus container: it takes focus on click, so the page keys keep working", () => {
    renderCodex();
    const page = surfaces();
    expect(page.getAttribute("data-pane-id")).toBe("page");
    expect(page.getAttribute("tabindex")).toBe("-1");
    expect(page.hasAttribute("data-pane-default")).toBe(true);
    // A click on dead space, or on a button that keeps focus where it was, leaves focus inside the page.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.click(cell("skills"));
    expect(page.contains(document.activeElement)).toBe(true);
  });

  it("has one cell per surface with its state pill and the switch of its target, and skills without a switch", () => {
    renderCodex();
    // Rules, agents, skills, settings in reading order. codex_config is off by default; codex_agents is on but has no
    // status row yet (no pill while it is not known); skills have no target.
    expect(cells()).toEqual([
      ["codex_rules", "Update ready", "true"],
      ["codex_agents", null, "true"],
      ["skills", "Up to date", null],
      ["codex_config", "Not managed", "false"],
    ]);
    // The label names the surface and where it lives; the switch says what it turns on.
    expect(cell("codex_rules").querySelector(".hp-lbl")!.textContent).toBe("Rules · .codex/AGENTS.md");
    expect(within(cell("codex_rules")).getByRole("switch", { name: "Let Riggverk manage codex rules" })).toBeTruthy();
    expect(within(cell("skills")).queryByRole("switch")).toBeNull();
  });

  it("says what the backend says in the cell, and why an off surface is off", () => {
    renderCodex();
    expect(cell("codex_rules").querySelector(".hp-ch b")!.textContent).toBe("update_available detail");
    expect(cell("codex_config").querySelector(".hp-ch b")!.textContent).toBe("config.toml");
    expect(cell("codex_config").textContent).toContain("Not managed. Turn on to let Riggverk manage it.");
    expect(cell("codex_agents").textContent).toContain("Checking…");
  });

  it("toggles the target from its switch, and a click on a cell only selects it", () => {
    const { props: p } = renderCodex();
    fireEvent.click(cell("codex_agents"));
    fireEvent.click(cell("skills"));
    expect(p.onToggleTarget).not.toHaveBeenCalled();
    fireEvent.click(within(cell("codex_agents")).getByRole("switch", { name: "Let Riggverk manage codex agents" }));
    expect(p.onToggleTarget).toHaveBeenLastCalledWith("codex_agents");
    fireEvent.click(within(cell("codex_config")).getByRole("switch", { name: "Let Riggverk manage codex config" }));
    expect(p.onToggleTarget).toHaveBeenLastCalledWith("codex_config");
    expect(p.onToggleTarget).toHaveBeenCalledTimes(2);
  });

  it("names the other surface a toggle also gates", () => {
    const cursorTargets: AgentTargetMeta[] = [
      { id: "cursor_setup", label: "cursor global agents", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "templates/cursor/agents" },
    ];
    const p = props({ agentTargets: cursorTargets, overview: overviewOf({}) });
    renderInFrame(<CursorView {...p} runtimeHealth={null} />);
    const page = screen.getByRole("region", { name: "Cursor" });
    expect(cell("cursor_agents", page).querySelector(".hp-lbl")!.textContent).toBe("Agents · .cursor/agents");
    expect(cell("cursor_agents", page).textContent).toContain("Also mcp");
    // The MCP file is not the target's path: its label names no file, but its switch is the same toggle.
    expect(cell("cursor_mcp", page).querySelector(".hp-lbl")!.textContent).toBe("MCP");
    expect(cell("cursor_mcp", page).textContent).toContain("Also agents");
    fireEvent.click(within(cell("cursor_mcp", page)).getByRole("switch"));
    expect(p.onToggleTarget).toHaveBeenCalledWith("cursor_setup");
  });

  it("shows autosave progress and failure in the mono line", () => {
    const { rerenderFrame, props: p } = renderCodex({ settingsSaveStatus: "pending" });
    const sub = () => surfaces().querySelector<HTMLElement>(".hp-sub")!;
    expect(sub().textContent).toContain("autosaving…");
    expect(within(sub()).getByRole("status").textContent).toContain("autosaving");
    rerenderFrame(<CodexView {...p} settingsSaveStatus="error" runtimeHealth={CODEX_HEALTH} />);
    expect(sub().textContent).toContain("not saved, retry in settings");
    expect(sub().textContent).not.toContain("autosaving");
  });

  it("shows the runtime facts of the harness in their own cell, without restating them as prose", () => {
    renderCodex();
    expect(runtime().querySelector(".hp-ch b")!.textContent).toBe("diverged");
    expect(facts(runtime())).toMatchObject({ skills: "synced · 17/18", approval: "on-request", sandbox: "workspace-write" });
    // The summary only restates the verdict; the next step stays while the runtime is out of sync.
    expect(runtime().textContent).not.toContain("Codex diverged");
    expect(facts(runtime()).next).toBe("update Codex");
    // Runtime health is never a state: no pill in its cell.
    expect(runtime().querySelector(".state-pill")).toBeNull();
  });

  it("shows a failed status check and the files an update preserved as notes of the page", () => {
    const status = installationStatus("conflict", [surfaceStatus("codex_rules", "conflict")], { conflict_count: 1 }, { conflict_details: ["~/.codex/AGENTS.md", "~/.codex/config.toml"] });
    const overview = overviewOf({ codex: status });
    const { props: p, rerenderFrame } = renderCodex({ overview });
    expect(surfaces().textContent).toContain("The update left alone: ~/.codex/AGENTS.md, ~/.codex/config.toml");
    expect(surfaces().textContent).not.toContain("conflict summary");
    const failed = { ...overview, entries: { codex: { id: "codex" as const, status: null, loading: false, error: "hash failed" } } };
    rerenderFrame(<CodexView {...p} overview={failed} runtimeHealth={CODEX_HEALTH} />);
    expect(surfaces().textContent).toContain("Status check failed: hash failed");
    // The cells do not claim a state they could not check.
    expect(cell("codex_rules").querySelector(".state-pill")).toBeNull();
    expect(cell("codex_rules").textContent).toContain("Couldn't check. Try Check again.");
  });

  it("opens the install review for this harness with u, and a read-only preview with p, from anywhere in the page", () => {
    const { props: p } = renderCodex();
    act(() => surfaces().focus());
    press("u");
    expect(p.install.open).toHaveBeenCalledWith("codex");
    press("p");
    expect(p.install.open).toHaveBeenLastCalledWith("codex", { readOnly: true });
    const inCell = within(cell("codex_agents")).getByRole("switch");
    act(() => inCell.focus());
    press("u", inCell);
    expect(p.install.open).toHaveBeenCalledTimes(3);
  });

  it("has Preview and Update buttons that open the same reviews", () => {
    const { props: p } = renderCodex();
    fireEvent.click(within(surfaces()).getByRole("button", { name: "Preview" }));
    expect(p.install.open).toHaveBeenLastCalledWith("codex", { readOnly: true });
    fireEvent.click(within(surfaces()).getByRole("button", { name: "update" }));
    expect(p.install.open).toHaveBeenLastCalledWith("codex");
  });

  it("does not update while target changes are still being saved", () => {
    const { props: p } = renderCodex({ settingsSaveStatus: "saving" });
    act(() => surfaces().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
    expect(hint(/update/).getAttribute("title")).toBe("saving target changes");
    const button = within(surfaces()).getByRole("button", { name: "update" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("saving target changes");
    fireEvent.click(button);
    expect(p.install.open).not.toHaveBeenCalled();
  });

  it("explains a missing workspace and offers no update", () => {
    const { props: p } = renderCodex({ dataFolderOk: false, overview: overviewOf({}) });
    expect(surfaces().textContent).toContain("The workspace folder is unusable");
    // The runtime cell carries the verdict; no row restates it under a heading that says something else.
    expect(runtime().querySelector(".hp-ch b")!.textContent).toBe("workspace folder unusable");
    expect(facts()).not.toHaveProperty("runtime");
    expect(facts()).not.toHaveProperty("rules");
    // Only the path is told in the mono line.
    expect(surfaces().querySelector(".hp-sub")!.textContent).toBe("~/.codex");
    act(() => surfaces().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
  });

  it("waits for the settings before it lists anything", () => {
    renderCodex({ appSettings: null });
    expect(surfaces().textContent).toContain("Loading settings…");
    expect(surfaces().querySelector("[data-surface]")).toBeNull();
  });

  it("shows the review in place of the page while it is open", () => {
    const flow = flowOf([op("codex_rules", "update")], { label: "update codex", surfaces: ["codex_rules"] });
    const install = installScreenOf(flow, "codex");
    renderCodex({ install });
    const review = screen.getByRole("region", { name: "Codex install review" });
    expect(review.className).toContain("review");
    expect(within(review).getAllByRole("region")).toHaveLength(1);
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Codex" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("grid", { name: "Install plan" }), { key: "y" });
    expect(install.apply).toHaveBeenCalledTimes(1);
  });

  it("offers Undo on the done review of an update applied from the page", () => {
    const flow = flowOf();
    const review = flowOf([op("codex_rules", "update")], { label: "update codex", surfaces: ["codex_rules"] }).review!;
    const result = { success: true, transaction_id: "tx-9", applied: ["CodexRules"], failed: [], rolled_back: [], manual_steps: [], message: "ok" };
    const install = { ...installScreenOf(flow, "codex"), done: { review, result, at: Date.now() }, isOpenOn: (view: string) => view === "codex" };
    const onUndo = vi.fn();
    renderCodex({ install, onUndo });
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(within(pane).getByText("Undo any time")).toBeTruthy();
    fireEvent.click(within(pane).getByRole("button", { name: "Undo this update…" }));
    expect(onUndo).toHaveBeenCalledWith("tx-9");
    cleanup();

    // Without an Undo to offer, the card does not promise one.
    renderCodex({ install });
    const bare = screen.getByRole("region", { name: "Install plan" });
    expect(within(bare).queryByRole("button", { name: "Undo this update…" })).toBeNull();
    expect(within(bare).queryByText("Undo any time")).toBeNull();
  });

  it("lists claude_config as an off cell with its own switch and what stays when it is off", () => {
    const p = props();
    renderInFrame(<ClaudeView {...p} runtimeHealth={CLAUDE_HEALTH} />);
    const claude = screen.getByRole("region", { name: "Claude" });
    expect(cells(claude)).toEqual([
      ["claude_rules", "Up to date", "true"],
      ["claude_agents", null, "true"],
      ["skills", null, null],
      ["claude_config", "Not managed", "false"],
    ]);
    const config = cell("claude_config", claude);
    expect(config.querySelector(".hp-lbl")!.textContent).toBe("Settings · .claude/settings.json");
    expect(config.textContent).toContain("Claude Code keeps its default commit and PR attribution");
    fireEvent.click(within(config).getByRole("switch", { name: "Let Riggverk manage claude config" }));
    expect(p.onToggleTarget).toHaveBeenCalledWith("claude_config");
  });

  it("shows the Claude runtime from its sync flags", () => {
    renderInFrame(<ClaudeView {...props()} runtimeHealth={CLAUDE_HEALTH} />);
    const claude = screen.getByRole("region", { name: "Claude" });
    expect(runtime(claude).querySelector(".hp-ch b")!.textContent).toBe("diverged");
    expect(facts(runtime(claude))).toMatchObject({ agents: "diverged · 5/6", "claude cli": "available" });
    expect(claude.textContent).not.toContain("Claude CLI available");
    expect(claude.querySelector(".hp-sub")!.textContent).toBe("~/.claude · 5 agents · CLI available");
  });

  it("shows the safety notes of the harness, loaded from its own config, as advice only", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { harness?: string }) => {
      if (command === "get_security_posture") return args?.harness === "claude" ? RISKY_CLAUDE : CLEAN_CODEX;
      return undefined;
    });
    renderInFrame(<ClaudeView {...props()} runtimeHealth={CLAUDE_HEALTH} />);
    const claude = screen.getByRole("region", { name: "Claude" });
    const safety = await within(claude).findByRole("region", { name: "Safety notes" });
    expect(safety.textContent).toContain("Advice only");
    expect(safety.textContent).toContain("1 risky");
    expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "claude" });
    cleanup();

    renderCodex();
    const codexSafety = await within(surfaces()).findByRole("region", { name: "Safety notes" });
    expect(codexSafety.textContent).toContain("no risky settings found in ~/.codex/config.toml");
    expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "codex" });
  });
});

describe("OpenCodeView model override", () => {
  const OPENCODE_HEALTH = { status: "synced", tui_status: "synced", tui_diverged_keys: [], agent_mismatches: [], warnings: [], cli: null, config_status: "synced", config_diverged_keys: [], config_precedence: { installed_not_strict: [], sibling_files: [], env_vars: [], system_managed_paths: [] }, rules_status: "synced", playwright_mcp_version: null, bundled_agent_count: 3, installed_bundled_agent_count: 3, default_agent: "build", autoupdate: "true", summary: "ok", next_action: "" } as unknown as OpenCodeRuntimeHealth;
  const BUNDLED: OpenCodeModelSelection = {
    model: "anthropic/claude-sonnet-4-5",
    small_model: "anthropic/claude-haiku-4-5",
    subagent_model: "",
    critic_model: "",
    model_source: "bundled default",
    small_model_source: "bundled default",
    subagent_source: "bundled default",
    critic_source: "bundled default",
  };
  const MODELS = ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "openai/gpt-5"];

  function backend({ saveResult = "Saved model selection", initial = BUNDLED, models = MODELS, warning = null }: { saveResult?: string; initial?: OpenCodeModelSelection; models?: string[]; warning?: string | null } = {}) {
    let selection = initial;
    invokeMock.mockImplementation(async (command: string, args?: { model?: string; smallModel?: string; subagentModel?: string | null; criticModel?: string | null }) => {
      switch (command) {
        case "read_opencode_model_selection":
          return selection;
        case "list_available_opencode_models":
          return { models, warning };
        case "update_opencode_model_selection": {
          const subagent = args!.subagentModel ?? "";
          const critic = args!.criticModel ?? "";
          // Like the backend: only a value that differs from the bundled default is an override.
          selection = {
            model: args!.model!,
            small_model: args!.smallModel!,
            subagent_model: subagent,
            critic_model: critic,
            model_source: args!.model === BUNDLED.model ? "bundled default" : "override",
            small_model_source: args!.smallModel === BUNDLED.small_model ? "bundled default" : "override",
            subagent_source: subagent ? "override" : "bundled default",
            critic_source: critic ? "override" : "bundled default",
          };
          return saveResult;
        }
        case "reset_opencode_model_selection":
          selection = BUNDLED;
          return "Model override removed. Run Install/Update to apply the bundled defaults.";
        default:
          throw new Error(`unexpected ${command}`);
      }
    });
  }

  function renderOpenCode(onModelUpdated = vi.fn(), runtimeHealth: OpenCodeRuntimeHealth = OPENCODE_HEALTH) {
    const merged = props({ appSettings: settingsOf() });
    renderInFrame(<OpenCodeView {...merged} runtimeHealth={runtimeHealth} onModelUpdated={onModelUpdated} />);
    return { onModelUpdated };
  }

  const originalShowModal = HTMLDialogElement.prototype.showModal;
  const originalClose = HTMLDialogElement.prototype.close;
  beforeEach(() => {
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
    HTMLDialogElement.prototype.showModal = originalShowModal;
    HTMLDialogElement.prototype.close = originalClose;
  });

  /** The page's own buttons for the model keys, not the test-only key hints. */
  const modelButton = (name: string) => within(screen.getByRole("region", { name: "Model selection" })).getByRole("button", { name });
  const confirmReset = async () => fireEvent.click(within(await screen.findByRole("dialog", { name: "Reset the model override?" })).getByRole("button", { name: "Reset" }));
  const model = () => screen.getByLabelText("model") as HTMLSelectElement;
  const subagent = () => screen.getByLabelText("subagent model") as HTMLSelectElement;
  const critic = () => screen.getByLabelText("critic model") as HTMLSelectElement;
  const paneBody = () => screen.getByRole("region", { name: "OpenCode" });
  const loaded = () => waitFor(() => expect(model().tagName === "SELECT" && model().value).toBe("anthropic/claude-sonnet-4-5"));
  const sourceLines = () => [...screen.getByRole("region", { name: "Model selection" }).querySelectorAll("dd")].map(dd => dd.textContent!).filter(text => text.startsWith("source:"));
  const diverged = (...keys: string[]) => ({ ...OPENCODE_HEALTH, config_status: "diverged", config_diverged_keys: keys }) as OpenCodeRuntimeHealth;

  it("keeps working: loads the selection, edits it in place and saves it", async () => {
    backend();
    const { onModelUpdated } = renderOpenCode();
    // The field is a text input until the model list arrives, then a select: look it up again each time.
    await loaded();
    const small = screen.getByLabelText("small model") as HTMLSelectElement;
    expect(small.value).toBe("anthropic/claude-haiku-4-5");
    expect(subagent().value).toBe("");

    const detailPane = screen.getByRole("region", { name: "OpenCode" });
    act(() => detailPane.focus());
    const save = hint(/save model/);
    expect(save.getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(model(), { target: { value: "openai/gpt-5" } });
    expect(hint(/save model/).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(hint(/save model/));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", {
      model: "openai/gpt-5",
      smallModel: "anthropic/claude-haiku-4-5",
      subagentModel: null,
      criticModel: null,
    }));
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
    expect(await within(detailPane).findByText("Saved model selection")).toBeTruthy();
  });

  it("offers Edit, Save, Reset and Reload as buttons, with the reasons the keys give", async () => {
    backend({ initial: { ...BUNDLED, model: "openai/gpt-5", model_source: "override" } });
    const { onModelUpdated } = renderOpenCode();
    await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
    expect(modelButton("save model").getAttribute("aria-disabled")).toBe("true");
    expect(modelButton("save model").getAttribute("title")).toBe("no unsaved change");

    fireEvent.click(modelButton("edit model"));
    expect(document.activeElement).toBe(model());

    fireEvent.change(model(), { target: { value: "anthropic/claude-haiku-4-5" } });
    expect(modelButton("save model").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(modelButton("save model"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", expect.objectContaining({ model: "anthropic/claude-haiku-4-5" })));
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));

    const listCalls = () => invokeMock.mock.calls.filter(([command]) => command === "list_available_opencode_models").length;
    const before = listCalls();
    fireEvent.click(modelButton("reload models"));
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it("asks before the Reset button drops the override, and keeps it on cancel", async () => {
    backend({ initial: { ...BUNDLED, model: "openai/gpt-5", model_source: "override" } });
    const { onModelUpdated } = renderOpenCode();
    await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
    fireEvent.click(modelButton("reset model"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Reset the model override?" })).getByRole("button", { name: "cancel" }));
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalledWith("reset_opencode_model_selection");
    expect(model().value).toBe("openai/gpt-5");

    fireEvent.click(modelButton("reset model"));
    await confirmReset();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("reset_opencode_model_selection"));
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
  });

  it("holds Update and Preview while model edits are unsaved, with the reason", async () => {
    backend();
    renderOpenCode();
    await loaded();
    const page = () => within(paneBody());
    expect(page().getByRole("button", { name: /preview/i }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.change(model(), { target: { value: "openai/gpt-5" } });
    for (const name of [/preview/i, /^(update|install)/i]) {
      const button = page().getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe("Save or discard the model change first");
    }
    fireEvent.change(model(), { target: { value: BUNDLED.model } });
    expect(page().getByRole("button", { name: /preview/i }).getAttribute("aria-disabled")).toBeNull();
  });

  it("reloads the model list with R, leaving m to the rules file in the same pane", async () => {
    backend();
    renderOpenCode();
    await waitFor(() => expect((screen.getByLabelText("model") as HTMLSelectElement).tagName).toBe("SELECT"));
    const body = screen.getByRole("region", { name: "OpenCode" });
    act(() => body.focus());
    const listCalls = () => invokeMock.mock.calls.filter(([command]) => command === "list_available_opencode_models").length;
    const before = listCalls();
    fireEvent.keyDown(body, { key: "m" });
    expect(listCalls()).toBe(before);
    fireEvent.keyDown(body, { key: "R" });
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it("saves from the keyboard with s once there is a change", async () => {
    backend();
    const { onModelUpdated } = renderOpenCode();
    await loaded();
    const body = paneBody();
    act(() => body.focus());
    fireEvent.keyDown(body, { key: "s" });
    expect(onModelUpdated).not.toHaveBeenCalled();
    fireEvent.change(model(), { target: { value: "openai/gpt-5" } });
    fireEvent.keyDown(body, { key: "s" });
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
  });

  it("falls back to text inputs when nothing is known and rejects a model without a provider", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "read_opencode_model_selection") return { ...BUNDLED, model: "", small_model: "" };
      if (command === "list_available_opencode_models") return { models: [], warning: "opencode models: unavailable" };
      throw new Error(`unexpected ${command}`);
    });
    renderOpenCode();
    const model = () => screen.getByLabelText("model") as HTMLInputElement;
    // No model list and nothing configured: the fields stay text inputs.
    await screen.findByText("opencode models: unavailable");
    expect(model().tagName).toBe("INPUT");
    expect((screen.getByLabelText("subagent model") as HTMLInputElement).tagName).toBe("INPUT");
    fireEvent.change(model(), { target: { value: "gpt-5" } });
    expect(screen.getByRole("alert").textContent).toBe("Must be provider/model format");
    expect(model().getAttribute("aria-invalid")).toBe("true");
    const detailPane = screen.getByRole("region", { name: "OpenCode" });
    act(() => detailPane.focus());
    // The key hints follow focus on its own schedule; under a loaded test run it can lag a tick.
    await waitFor(() => expect(hint(/save model/).getAttribute("title")).toBe("Must be provider/model format"));
    expect(detailPane.textContent).toContain("opencode models: unavailable");
  });

  it("does not load models without a valid workspace", () => {
    backend();
    const merged = props({ dataFolderOk: false, overview: overviewOf({}) });
    renderInFrame(<OpenCodeView {...merged} runtimeHealth={null} onModelUpdated={vi.fn()} />);
    // The security posture reads the harness's own config, not the workspace; nothing else is loaded.
    expect(invokeMock.mock.calls.filter(([command]) => command !== "get_security_posture")).toEqual([]);
    expect(screen.queryByLabelText("model")).toBeNull();
  });

  describe("subagent model", () => {
    it("saves a role override while leaving both main model fields empty", async () => {
      backend({ initial: { ...BUNDLED, model: "", small_model: "" } });
      renderOpenCode();
      await waitFor(() => expect(model().tagName).toBe("SELECT"));
      expect(model().value).toBe("");
      expect(model().selectedOptions[0].textContent).toBe("agent default or existing config");
      fireEvent.change(subagent(), { target: { value: "openai/gpt-5" } });
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "s" });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", {
        model: "", smallModel: "", subagentModel: "openai/gpt-5", criticModel: null,
      }));
    });
    it("is optional: it starts as inherit, and picking a model saves it with the other two", async () => {
      backend();
      const { onModelUpdated } = renderOpenCode();
      await loaded();
      expect([...subagent().options].map(option => option.textContent)[0]).toBe("inherit main model");
      expect(sourceLines()[2]).toContain("source: bundled default");

      fireEvent.change(subagent(), { target: { value: "openai/gpt-5" } });
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "s" });

      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", {
        model: "anthropic/claude-sonnet-4-5",
        smallModel: "anthropic/claude-haiku-4-5",
        subagentModel: "openai/gpt-5",
        criticModel: null,
      }));
      await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(subagent().value).toBe("openai/gpt-5"));
      // Only what the user changed is an override: the main models keep following the bundled default.
      expect(sourceLines().map(line => line.split(" · ")[0])).toEqual(["source: bundled default", "source: bundled default", "source: override", "source: bundled default"]);
    });

    it("can be cleared by choosing inherit and saving", async () => {
      backend({ initial: { ...BUNDLED, subagent_model: "openai/gpt-5", subagent_source: "override" } });
      renderOpenCode();
      await waitFor(() => expect(subagent().value).toBe("openai/gpt-5"));
      fireEvent.change(subagent(), { target: { value: "" } });
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "s" });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", expect.objectContaining({ subagentModel: null })));
    });

    it("rejects a value without a provider", async () => {
      backend();
      renderOpenCode();
      await loaded();
      fireEvent.change(subagent(), { target: { value: "__custom__" } });
      const input = await waitFor(() => {
        const found = screen.getByLabelText("subagent model") as HTMLInputElement;
        expect(found.tagName).toBe("INPUT");
        return found;
      });
      fireEvent.change(input, { target: { value: "gpt-5" } });
      expect(screen.getByRole("alert").textContent).toBe("Must be provider/model format");
      const body = paneBody();
      act(() => body.focus());
      await waitFor(() => expect(hint(/save model/).getAttribute("title")).toBe("Must be provider/model format"));
    });
  });

  describe("critic model", () => {
    it("saves a CLI model for inspector while retaining the other model selections", async () => {
      backend({ initial: { ...BUNDLED, subagent_model: "anthropic/claude-haiku-4-5", subagent_source: "override" } });
      const { onModelUpdated } = renderOpenCode();
      await loaded();
      expect(critic().value).toBe("");
      expect(critic().options[0].textContent).toBe("inherit subagent or main model");
      expect(screen.getByText("used by the adversarial skills' critic (inspector)")).toBeTruthy();
      fireEvent.change(critic(), { target: { value: "openai/gpt-5" } });
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "s" });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", {
        model: BUNDLED.model, smallModel: BUNDLED.small_model,
        subagentModel: "anthropic/claude-haiku-4-5", criticModel: "openai/gpt-5",
      }));
      await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
      expect(sourceLines()[3]).toContain("source: override");
    });

    it("clears only the critic by saving inherit and tracks inspector through the fallback", async () => {
      backend({ initial: { ...BUNDLED, subagent_model: "anthropic/claude-haiku-4-5", subagent_source: "override", critic_model: "openai/gpt-5", critic_source: "override" } });
      renderOpenCode(vi.fn(), diverged("agent.inspector.model"));
      await waitFor(() => expect(critic().value).toBe("openai/gpt-5"));
      fireEvent.change(critic(), { target: { value: "" } });
      // Unsaved drafts do not change which row owns the installed inspector drift.
      expect(sourceLines()[2]).toContain("state: applied");
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "s" });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", expect.objectContaining({
        subagentModel: "anthropic/claude-haiku-4-5", criticModel: null,
      })));
      await waitFor(() => expect(sourceLines()[3]).toBe("source: bundled default · state: pending apply (u to update)"));
      expect(sourceLines()[2]).toBe("source: override · state: pending apply (u to update)");
    });

    it("offers x when the critic is the only override and resets it", async () => {
      backend({ initial: { ...BUNDLED, critic_model: "openai/gpt-5", critic_source: "override" } });
      const { onModelUpdated } = renderOpenCode();
      await waitFor(() => expect(critic().value).toBe("openai/gpt-5"));
      const body = paneBody();
      act(() => body.focus());
      await waitFor(() => expect(hint(/reset model/).getAttribute("aria-disabled")).toBeNull());
      fireEvent.keyDown(body, { key: "x" });
      await confirmReset();
      await waitFor(() => expect(critic().value).toBe(""));
      expect(model().value).toBe(BUNDLED.model);
      expect(subagent().value).toBe("");
      await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
      expect(sourceLines()[3]).toContain("source: bundled default");
    });

    it("validates a custom critic model before saving", async () => {
      backend();
      renderOpenCode();
      await loaded();
      fireEvent.change(critic(), { target: { value: "__custom__" } });
      const input = screen.getByLabelText("critic model") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "no-provider" } });
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toBe("Must be provider/model format");
      const body = paneBody();
      act(() => body.focus());
      await waitFor(() => expect(hint(/save model/).getAttribute("title")).toBe("Must be provider/model format"));
      fireEvent.keyDown(body, { key: "s" });
      expect(invokeMock.mock.calls.some(([command]) => command === "update_opencode_model_selection")).toBe(false);
    });

    it.each([
      { keys: [], subagentState: "applied", criticState: "applied" },
      { keys: ["agent.inspector.model"], subagentState: "applied", criticState: "pending apply (u to update)" },
      { keys: ["agent.scribe.model"], subagentState: "pending apply (u to update)", criticState: "applied" },
    ])("reports separate applied states for $keys", async ({ keys, subagentState, criticState }) => {
      backend({ initial: { ...BUNDLED, subagent_model: "anthropic/claude-haiku-4-5", subagent_source: "override", critic_model: "openai/gpt-5", critic_source: "override" } });
      renderOpenCode(vi.fn(), keys.length ? diverged(...keys) : OPENCODE_HEALTH);
      await waitFor(() => expect(critic().value).toBe("openai/gpt-5"));
      expect(sourceLines()[2]).toBe(`source: override · state: ${subagentState}`);
      expect(sourceLines()[3]).toBe(`source: override · state: ${criticState}`);
    });
  });

  describe("source and state", () => {
    it("shows the bundled default as applied when the installed config matches", async () => {
      backend();
      renderOpenCode();
      await loaded();
      await waitFor(() => expect(sourceLines()).toHaveLength(4));
      expect(sourceLines()).toEqual([
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
      ]);
    });

    it("shows an override as pending apply, with the update key, while the installed config differs", async () => {
      backend({ initial: { ...BUNDLED, model: "openai/gpt-5", model_source: "override" } });
      renderOpenCode(vi.fn(), diverged("model"));
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      await waitFor(() => expect(sourceLines()).toHaveLength(4));
      const [main, small, sub] = sourceLines();
      expect(main).toBe("source: override · state: pending apply (u to update)");
      // Only the managed keys that differ are pending: the small model and the subagent model are installed.
      // Each value has its own source: the small model was never overridden.
      expect(small).toBe("source: bundled default · state: applied");
      expect(sub).toBe("source: bundled default · state: applied");
    });

    it("marks the subagent model pending when any role entry differs", async () => {
      backend({ initial: { ...BUNDLED, subagent_model: "openai/gpt-5", subagent_source: "override" } });
      renderOpenCode(vi.fn(), diverged("agent.inspector.model", "agent.scribe.model"));
      await waitFor(() => expect(subagent().value).toBe("openai/gpt-5"));
      await waitFor(() => expect(sourceLines()).toHaveLength(4));
      expect(sourceLines()).toEqual([
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
        "source: override · state: pending apply (u to update)",
        "source: bundled default · state: pending apply (u to update)",
      ]);
    });

    it("is pending everywhere while nothing is installed, and says no state while health is unknown", async () => {
      backend();
      renderOpenCode(vi.fn(), { ...OPENCODE_HEALTH, config_status: "missing" } as OpenCodeRuntimeHealth);
      await waitFor(() => expect(sourceLines()).toHaveLength(4));
      expect(sourceLines().every(line => line.endsWith("state: pending apply (u to update)"))).toBe(true);
      cleanup();

      backend();
      renderOpenCode(vi.fn(), null as unknown as OpenCodeRuntimeHealth);
      await waitFor(() => expect(sourceLines()).toHaveLength(4));
      expect(sourceLines()).toEqual(["source: bundled default", "source: bundled default", "source: bundled default", "source: bundled default"]);
    });
  });

  describe("reset", () => {
    const OVERRIDE: OpenCodeModelSelection = { ...BUNDLED, model: "openai/gpt-5", subagent_model: "anthropic/claude-haiku-4-5", critic_model: "openai/gpt-5", model_source: "override", subagent_source: "override", critic_source: "override" };

    it("deletes the override with x and returns every row to the bundled default", async () => {
      backend({ initial: OVERRIDE });
      const { onModelUpdated } = renderOpenCode();
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      const body = paneBody();
      act(() => body.focus());
      expect(hint(/reset model/).getAttribute("aria-disabled")).toBeNull();

      fireEvent.keyDown(body, { key: "x" });
      await confirmReset();

      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("reset_opencode_model_selection"));
      await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(model().value).toBe("anthropic/claude-sonnet-4-5"));
      expect(subagent().value).toBe("");
      expect(critic().value).toBe("");
      expect(await within(screen.getByRole("region", { name: "OpenCode" })).findByText(/Model override removed/)).toBeTruthy();
      await waitFor(() => expect(sourceLines()[0]).toContain("source: bundled default"));
      expect(sourceLines()[2]).toContain("source: bundled default");
      expect(sourceLines()[3]).toContain("source: bundled default");
    });

    it("drops unsaved edits along with the override", async () => {
      backend({ initial: OVERRIDE });
      renderOpenCode();
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      fireEvent.change(model(), { target: { value: "anthropic/claude-haiku-4-5" } });
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "x" });
      await confirmReset();
      await waitFor(() => expect(model().value).toBe("anthropic/claude-sonnet-4-5"));
    });

    it("is offered only while an override exists", async () => {
      backend();
      renderOpenCode();
      await loaded();
      const body = paneBody();
      act(() => body.focus());
      await waitFor(() => expect(hint(/reset model/).getAttribute("title")).toBe("no override to reset"));
      fireEvent.keyDown(body, { key: "x" });
      expect(invokeMock).not.toHaveBeenCalledWith("reset_opencode_model_selection");
    });

    it("reports a failed reset and leaves the rows as they were", async () => {
      backend({ initial: OVERRIDE });
      const base = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation(async (command: string, args?: unknown) => {
        if (command === "reset_opencode_model_selection") throw new Error("failed to remove model override: denied");
        return base(command, args);
      });
      const { onModelUpdated } = renderOpenCode();
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "x" });
      await confirmReset();
      expect(await screen.findByText("failed to remove model override: denied")).toBeTruthy();
      expect(model().value).toBe("openai/gpt-5");
      expect(onModelUpdated).not.toHaveBeenCalled();
    });
  });

  describe("options", () => {
    it("groups the models by provider", async () => {
      backend();
      renderOpenCode();
      await loaded();
      const groups = [...model().querySelectorAll("optgroup")].map(group => [group.label, [...group.querySelectorAll("option")].map(option => option.value)]);
      expect(groups).toEqual([
        ["anthropic", ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5"]],
        ["openai", ["openai/gpt-5"]],
      ]);
    });

    it("marks a value that opencode models does not list, and only that one", async () => {
      backend({ initial: { ...BUNDLED, model: "gone/model-1", model_source: "override" } });
      renderOpenCode();
      await waitFor(() => expect(model().value).toBe("gone/model-1"));
      const labels = [...model().querySelectorAll("option")].map(option => option.textContent);
      expect(labels).toContain("gone/model-1 (not in opencode models)");
      expect(labels).toContain("openai/gpt-5");
      expect(labels.filter(label => label?.includes("not in opencode models"))).toHaveLength(1);
    });

    it("marks nothing unavailable while the listing is unknown or partial", async () => {
      backend({ initial: { ...BUNDLED, model: "gone/model-1", model_source: "override" }, warning: "opencode models reported a non-zero exit." });
      renderOpenCode();
      await waitFor(() => expect(model().value).toBe("gone/model-1"));
      await screen.findByText("opencode models reported a non-zero exit.");
      expect([...model().querySelectorAll("option")].some(option => option.textContent?.includes("not in opencode models"))).toBe(false);
    });

    it("takes a custom provider as text and goes back to the list with Esc", async () => {
      backend();
      renderOpenCode();
      await loaded();
      fireEvent.change(model(), { target: { value: "__custom__" } });
      const input = await waitFor(() => {
        const found = screen.getByLabelText("model") as HTMLInputElement;
        expect(found.tagName).toBe("INPUT");
        return found;
      });
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.change(input, { target: { value: "lmstudio/google/gemma-3n" } });

      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "s" });
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", expect.objectContaining({ model: "lmstudio/google/gemma-3n" })));
      // The saved value is back in the list, marked as one opencode models does not know.
      await waitFor(() => expect(model().tagName).toBe("SELECT"));
      expect(model().value).toBe("lmstudio/google/gemma-3n");
      expect([...model().options].find(option => option.value === "lmstudio/google/gemma-3n")!.textContent).toContain("not in opencode models");
    });

    it("leaves the custom input for the list on Esc", async () => {
      backend();
      renderOpenCode();
      await loaded();
      fireEvent.change(model(), { target: { value: "__custom__" } });
      const input = await waitFor(() => {
        const found = screen.getByLabelText("model") as HTMLInputElement;
        expect(found.tagName).toBe("INPUT");
        return found;
      });
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(model().tagName).toBe("SELECT"));
      expect(model().value).toBe("anthropic/claude-sonnet-4-5");
    });
  });
});

describe("HarnessPage skill loads", () => {
  const CODEX_FOLDERS = [
    { folder: "agents" as const, path: "~/.agents/skills", exists: true },
    { folder: "codex_home" as const, path: "~/.codex/skills", exists: false },
  ];

  function copy(folder: "agents" | "codex_home", name: string): SkillCopy {
    const path = folder === "agents" ? "~/.agents/skills" : "~/.codex/skills";
    return { folder, path: `${path}/${name}`, hash: "aaaaaaaaaaaa", owner: "aw", current: true };
  }

  function codexLoads(twice: string[], once: string[] = []): EffectiveSkillLoads {
    return {
      harnesses: [
        {
          harness: "codex",
          folders: CODEX_FOLDERS,
          skills: [
            ...twice.map(name => ({ name, copies: [copy("agents", name), copy("codex_home", name)], winner: null, flags: ["plain_mention_ambiguous" as const] })),
            ...once.map(name => ({ name, copies: [copy("agents", name)], winner: 0, flags: [] })),
          ],
        },
      ],
      foreign_duplicates: [],
    };
  }

  function labels(root: HTMLElement = runtime()) {
    return [...root.querySelectorAll("dt")].map(dt => dt.textContent);
  }

  function valueOf(label: string, root: HTMLElement = runtime()) {
    return [...root.querySelectorAll("dt")].find(dt => dt.textContent === label)!.nextElementSibling!;
  }

  it("shows the loads below the skills row of the runtime facts, and keeps the sync row as it was", () => {
    renderCodex({ skillLoads: skillLoadsOf(codexLoads(["tdd", "diagnose"], ["zoom-out"])) });
    const rows = labels();
    expect(rows.indexOf("skill loads")).toBe(rows.indexOf("skills") + 1);
    expect(facts(runtime())).toMatchObject({ skills: "synced · 17/18", "skill loads": "2 names with 2 copies" });
    const text = runtime().textContent!;
    expect(text).toContain("diagnose · ~/.agents/skills + ~/.codex/skills · plain $name mention is ambiguous");
    expect(text).toContain("tdd · ~/.agents/skills + ~/.codex/skills");
  });

  it("keeps the flagged names with the skill loads row instead of giving them cells with empty labels", () => {
    renderCodex({ skillLoads: skillLoadsOf(codexLoads(["tdd", "diagnose"], ["zoom-out"])) });
    expect(labels().filter(label => label === "")).toEqual([]);
    const block = valueOf("skill loads").closest(".hp-fact")!;
    expect(block.className).toContain("hp-fact-block");
    expect([...block.querySelectorAll("dd")].map(dd => dd.textContent)).toEqual([
      "2 names with 2 copies",
      expect.stringContaining("tdd ·"),
      expect.stringContaining("diagnose ·"),
    ]);
    // A plain fact stays its own cell.
    expect(valueOf("skills").closest(".hp-fact")!.className).not.toContain("hp-fact-block");
  });

  it("says each skill has one copy when none is duplicated, in the ok tone", () => {
    renderCodex({ skillLoads: skillLoadsOf(codexLoads([], ["tdd", "diagnose"])) });
    expect(facts(runtime())["skill loads"]).toBe("2 skills, 1 copy each");
    expect(valueOf("skill loads").className).toContain("c-ok");
  });

  it("tells the number of duplicate names in the skills cell, which stays up to date", () => {
    renderCodex({ skillLoads: skillLoadsOf(codexLoads(["tdd", "diagnose"])) });
    expect(cell("skills").querySelector(".hp-ch b")!.textContent).toBe("2 skills");
    expect(cell("skills").textContent).toContain("2 skill names with several copies");
    // Duplicates are a note, not a state of their own; the other cells are not touched.
    expect(cell("skills").querySelector(".state-pill")!.textContent).toBe("Up to date");
    expect(cell("codex_rules").textContent).not.toContain("several copies");
  });

  it("leaves the skills cell alone while nothing is duplicated, loaded or readable", () => {
    for (const skillLoads of [skillLoadsOf(codexLoads([], ["tdd"])), skillLoadsOf(null), skillLoadsOf(null, "boom")]) {
      renderCodex({ skillLoads });
      expect(cell("skills").textContent).not.toContain("several copies");
      expect(cell("skills").querySelector(".state-pill")!.textContent).toBe("Up to date");
      cleanup();
    }
  });

  it("says the loads could not be read instead of showing none", () => {
    renderCodex({ skillLoads: skillLoadsOf(null, "workspace invalid") });
    expect(facts(runtime())["skill loads"]).toBe("not checked: workspace invalid");
  });

  it("names the folders the harness reads in the skills cell", () => {
    renderCodex({ skillLoads: skillLoadsOf(codexLoads([], ["tdd"])) });
    expect(facts(cell("skills"))).toMatchObject({ reads: "~/.agents/skills, ~/.codex/skills (missing)" });
    expect(facts(cell("codex_rules"))).not.toHaveProperty("reads");
  });

  it("shows the loads on the OpenCode page, which has no skills row of its own", () => {
    const health = { status: "synced", tui_status: "synced", tui_diverged_keys: [], agent_mismatches: [], warnings: [], cli: null, config_status: "synced", config_diverged_keys: [], config_precedence: { installed_not_strict: [], sibling_files: [], env_vars: [], system_managed_paths: [] }, rules_status: "synced", playwright_mcp_version: null, bundled_agent_count: 3, installed_bundled_agent_count: 3, default_agent: "build", autoupdate: "true", summary: "ok", next_action: "" } as unknown as OpenCodeRuntimeHealth;
    const skillLoads = skillLoadsOf({
      harnesses: [{
        harness: "opencode",
        folders: [{ folder: "claude", path: "~/.claude/skills", exists: true }, { folder: "agents", path: "~/.agents/skills", exists: true }],
        skills: [{ name: "tdd", copies: [{ ...copy("agents", "tdd"), folder: "claude", path: "~/.claude/skills/tdd" }, copy("agents", "tdd")], winner: null, flags: ["duplicate_identical"] }],
      }],
      foreign_duplicates: [],
    });
    renderInFrame(<HarnessPage {...props({ skillLoads })} harness="opencode" runtime={{ harness: "opencode", health }} />);
    const opencode = screen.getByRole("region", { name: "OpenCode" });
    const rows = labels(runtime(opencode));
    expect(rows).not.toContain("skills");
    expect(rows.indexOf("skill loads")).toBe(rows.indexOf("agents") + 1);
    // Identical copies are information: not a warning.
    expect(facts(runtime(opencode))["skill loads"]).toBe("1 skill · 1 with identical copies");
    expect(valueOf("skill loads", runtime(opencode)).className).not.toContain("c-warn");
  });
});

describe("OpenCode runtime rows on the page", () => {
  const OPENCODE_HEALTH = {
    status: "diverged",
    agent_mismatches: [{ filename: "architect.md", status: "diverged", detail: "" }, { filename: "verifier.md", status: "missing", detail: "" }],
    warnings: [],
    cli: { status: "supported", version: "1.19.3", major: 1, detail: "OpenCode 1.19.3" },
    config_status: "diverged",
    config_diverged_keys: ["model", "mcp.playwright"],
    config_precedence: { installed_not_strict: [], sibling_files: [], env_vars: [], system_managed_paths: [] },
    rules_status: "synced",
    playwright_mcp_version: "0.0.47",
    tui_status: "diverged",
    tui_diverged_keys: ["theme"],
    bundled_agent_count: 6,
    installed_bundled_agent_count: 4,
    default_agent: "architect",
    autoupdate: "notify",
    summary: "diverged",
    next_action: "Run diff before apply.",
  } as unknown as OpenCodeRuntimeHealth;

  it("names what differs instead of a bare status", () => {
    renderInFrame(<HarnessPage {...props()} harness="opencode" runtime={{ harness: "opencode", health: OPENCODE_HEALTH }} />);
    const opencode = screen.getByRole("region", { name: "OpenCode" });
    expect(runtime(opencode).querySelector(".hp-ch b")!.textContent).toBe("diverged");
    expect(facts(runtime(opencode))).toMatchObject({
      cli: "1.19.3",
      rules: "synced",
      agents: "4/6 · diverged: architect.md · missing: verifier.md",
      config: "diverged · model, mcp.playwright",
      "mcp playwright": "diverged · 0.0.47",
      tui: "diverged · theme",
      next: "run diff before apply",
    });
    const toneOf = (label: string) => [...runtime(opencode).querySelectorAll("dt")].find(dt => dt.textContent === label)!.nextElementSibling!.className;
    expect(toneOf("agents")).toContain("c-warn");
    expect(toneOf("tui")).toContain("c-warn");
    expect(toneOf("rules")).toContain("c-ok");
  });
});
