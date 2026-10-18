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
  STATUS_DATA,
  surfaceStatus,
} from "../test/pageFixtures";
import type { AgentTargetMeta, ApplyProgress, ClaudeRuntimeHealth, CodexRuntimeHealth, OpenCodeModelSelection, OpenCodeRuntimeHealth } from "../types";
import { ClaudeView } from "./ClaudeView";
import { CodexView } from "./CodexView";
import { CursorView } from "./CursorView";
import { OpenCodeView } from "./OpenCodeView";
import type { HarnessViewProps } from "./pageTypes";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const outputStripProps = vi.fn();

// The real strip, with its props recorded: the pages must hand it the backend's progress.
vi.mock("../components/OutputStrip", async importOriginal => {
  const actual = await importOriginal<typeof import("../components/OutputStrip")>();
  return {
    ...actual,
    OutputStrip: (stripProps: Parameters<typeof actual.OutputStrip>[0]) => {
      outputStripProps(stripProps);
      return <actual.OutputStrip {...stripProps} />;
    },
  };
});

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/codex-rules.md" },
  { id: "codex_agents", label: "codex agents", harness: "codex", kind: "agents", target_rel: ".codex/agents", source_rel: "templates/codex/agents" },
  { id: "codex_config", label: "codex config", harness: "codex", kind: "config", target_rel: ".codex/config.toml", source_rel: "templates/codex/config.toml" },
  { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", target_rel: ".claude/CLAUDE.md", source_rel: "templates/claude-rules.md" },
  { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", target_rel: ".claude/agents", source_rel: "templates/claude/agents" },
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
    overview: overviewOf({
      codex: installationStatus("update_available", [surfaceStatus("codex_rules", "update_available"), surfaceStatus("codex_skills", "current")], { update_count: 1 }),
      claude: installationStatus("current", [surfaceStatus("claude_rules", "current")]),
    }),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRollback: vi.fn(),
    onRefresh: vi.fn(),
    runWorkspaceTask: vi.fn(async () => null) as unknown as HarnessViewProps["runWorkspaceTask"],
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
  };
}

function renderCodex(overrides: Partial<HarnessViewProps> = {}) {
  const merged = props(overrides);
  return { props: merged, ...renderInFrame(<CodexView {...merged} runtimeHealth={CODEX_HEALTH} />) };
}

function surfaces() {
  return screen.getByRole("listbox", { name: "Codex surfaces" });
}

function detail() {
  return screen.getByRole("region", { name: "Codex detail" });
}

function press(key: string, target: Element = surfaces()) {
  fireEvent.keyDown(target, { key });
}

function statusBar() {
  return within(screen.getByLabelText("Status bar"));
}

/** A key hint of the focused pane: hints live in the status bar, not in the panes. */
function hint(name: RegExp) {
  return statusBar().getByRole("button", { name });
}

/** The `dt` -> `dd` pairs of the detail pane, runtime rows included. */
function facts(root: HTMLElement = detail()): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dt of root.querySelectorAll("dt")) result[dt.textContent!] = dt.nextElementSibling!.textContent!;
  return result;
}

function rowText(row: Element) {
  return [row.querySelector(".nm")!.textContent!.replace(/ /g, " ").replace(/\s+/g, " ").trim(), row.querySelector(".meta")!.textContent!.trim()];
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe("HarnessPage", () => {
  it("shows two panes, the surfaces and their detail, and the output as a strip", () => {
    renderCodex();
    const page = screen.getByRole("region", { name: "Codex" });
    expect(page.className).toContain("pair");
    expect(within(page).getAllByRole("region").map(pane => pane.getAttribute("aria-label"))).toEqual([
      "Codex surfaces",
      "Codex detail",
      "Output",
    ]);
    expect(page.querySelector(".outstrip")).not.toBeNull();
  });

  it("lists one row per surface with the toggle of its target, and skills without one", () => {
    renderCodex();
    // Single-select: the highlight is the cursor row, the one the detail shows; [x] tells the toggle.
    expect(surfaces().getAttribute("aria-multiselectable")).toBeNull();
    const rows = within(surfaces()).getAllByRole("option");
    // codex_config is off by default; codex_agents is on but has no status row yet; skills have no target.
    expect(rows.map(rowText)).toEqual([
      ["[ ] config .codex/config.toml", "off"],
      ["[x] agents .codex/agents", "unknown"],
      ["[x] rules .codex/AGENTS.md", "update"],
      ["skills", "current"],
    ]);
    expect(rows.map(row => row.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    // One signal per row: the state word in its tone, no glyph.
    expect(rows[2]!.querySelector(".meta")!.className).toContain("c-warn");
    expect(rows[3]!.querySelector(".meta")!.className).toContain("c-ok");
    expect(rows[2]!.querySelector(".meta .g")).toBeNull();
  });

  it("offers the codex agents toggle, which the page used to leave out", () => {
    const { props: p } = renderCodex();
    act(() => surfaces().focus());
    press("j");
    expect(detail().querySelector(".pane-title")!.textContent).toContain("agents");
    press(" ");
    expect(p.onToggleTarget).toHaveBeenCalledWith("codex_agents");
  });

  it("Space toggles the target of the row under the cursor; a click only selects the row", () => {
    const { props: p } = renderCodex();
    const rows = within(surfaces()).getAllByRole("option");
    act(() => surfaces().focus());
    press(" ");
    expect(p.onToggleTarget).toHaveBeenLastCalledWith("codex_config");
    press("j");
    press("j");
    press(" ");
    expect(p.onToggleTarget).toHaveBeenLastCalledWith("codex_rules");
    // Clicking to inspect a row must not flip it (codex config rewrites the approval posture).
    fireEvent.click(rows[1]!);
    expect(p.onToggleTarget).toHaveBeenCalledTimes(2);
    expect(detail().querySelector(".pane-title")!.textContent).toContain("agents");
    press(" ");
    expect(p.onToggleTarget).toHaveBeenLastCalledWith("codex_agents");
  });

  it("offers the toggle as a status-bar hint, and it toggles too", () => {
    const { props: p } = renderCodex();
    act(() => surfaces().focus());
    fireEvent.click(hint(/toggle target/));
    expect(p.onToggleTarget).toHaveBeenCalledWith("codex_config");
  });

  it("says skills have no target toggle instead of toggling them", () => {
    const { props: p } = renderCodex();
    act(() => surfaces().focus());
    press("G");
    expect(detail().querySelector(".pane-title")!.textContent).toContain("skills");
    press(" ");
    expect(p.onToggleTarget).not.toHaveBeenCalled();
    expect(statusBar().getByText("skills have no target toggle")).toBeTruthy();
  });

  it("shows the detail of the row under the cursor and follows it", () => {
    renderCodex();
    act(() => surfaces().focus());
    const title = () => detail().querySelector(".pane-title")!.textContent;
    // The first row: config, off, with its target.
    expect(title()).toContain("config · off");
    expect(facts()).toMatchObject({
      file: ".codex/config.toml",
      source: "templates/codex/config.toml",
      target: "codex config · off",
    });
    // The state is the title's; it is not repeated as a row.
    expect(facts()).not.toHaveProperty("state");
    press("j");
    press("j");
    expect(title()).toContain("rules · update");
    expect(facts()).toMatchObject({ file: ".codex/AGENTS.md", target: "codex rules · on", detail: "update_available detail" });
    press("j");
    // Skills: no file, source or target to show, only what the backend said.
    expect(title()).toContain("skills · current");
    const skills = facts();
    expect(skills).toMatchObject({ detail: "current detail" });
    expect(skills).not.toHaveProperty("file");
    expect(skills).not.toHaveProperty("source");
    expect(skills).not.toHaveProperty("target");
  });

  it("names the other surface a toggle also gates", () => {
    const cursorTargets: AgentTargetMeta[] = [
      { id: "cursor_setup", label: "cursor global agents", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "templates/cursor/agents" },
    ];
    const p = props({ agentTargets: cursorTargets, overview: overviewOf({}) });
    renderInFrame(<CursorView {...p} runtimeHealth={null} />);
    const list = screen.getByRole("listbox", { name: "Cursor surfaces" });
    act(() => list.focus());
    const cursorDetail = () => screen.getByRole("region", { name: "Cursor detail" });
    expect(facts(cursorDetail())).toMatchObject({ file: ".cursor/agents", target: "cursor global agents · on · also mcp" });
    press("G", list);
    // The MCP file is not the target's path: it names the toggle, not a file that is not its own.
    const mcp = facts(cursorDetail());
    expect(mcp).toMatchObject({ target: "cursor global agents · on · also agents" });
    expect(mcp).not.toHaveProperty("file");
    press(" ", list);
    expect(p.onToggleTarget).toHaveBeenCalledWith("cursor_setup");
  });

  it("moves focus to the output strip when an apply leaves a rollback transaction, so z works", () => {
    const { rerenderFrame, props: p } = renderCodex();
    act(() => surfaces().focus());
    rerenderFrame(<CodexView {...p} rollbackTransactionId="tx-1" runtimeHealth={CODEX_HEALTH} />);
    expect(document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("output");
    fireEvent.keyDown(document.activeElement!, { key: "z" });
    expect(p.onRollback).toHaveBeenCalledTimes(1);
  });

  it("shows autosave progress and failure next to the harness state", () => {
    const { rerenderFrame, props: p } = renderCodex({ settingsSaveStatus: "pending" });
    const title = () => screen.getByRole("region", { name: "Codex surfaces" }).querySelector(".pane-title")!.textContent;
    expect(title()).toContain("update");
    expect(title()).toContain("autosaving");
    rerenderFrame(<CodexView {...p} settingsSaveStatus="error" runtimeHealth={CODEX_HEALTH} />);
    expect(title()).toContain("not saved");
  });

  it("shows the runtime facts of the harness under the surface, without restating them as prose", () => {
    renderCodex();
    const runtime = facts();
    expect(detail().textContent).toContain("runtime · diverged");
    expect(runtime).toMatchObject({ skills: "synced · 17/18", approval: "on-request", sandbox: "workspace-write" });
    // The summary only restates the verdict; the next step stays while the runtime is out of sync.
    expect(detail().textContent).not.toContain("Codex diverged");
    expect(runtime.next).toBe("update Codex");
  });

  it("shows a failed status check and the files an update preserved as facts of the harness", () => {
    const status = installationStatus("conflict", [surfaceStatus("codex_rules", "conflict")], { conflict_count: 1 }, { conflict_details: ["~/.codex/AGENTS.md", "~/.codex/config.toml"] });
    const overview = overviewOf({ codex: status });
    const { props: p, rerenderFrame } = renderCodex({ overview });
    expect(facts()).toMatchObject({ preserved: "~/.codex/AGENTS.md, ~/.codex/config.toml" });
    expect(detail().textContent).not.toContain("conflict summary");
    const failed = { ...overview, entries: { codex: { id: "codex" as const, status: null, loading: false, error: "hash failed" } } };
    rerenderFrame(<CodexView {...p} overview={failed} runtimeHealth={CODEX_HEALTH} />);
    expect(facts()).toMatchObject({ status: "failed: hash failed" });
  });

  it("opens the install review for this harness with u, and a read-only preview with p, from either pane", () => {
    const { props: p } = renderCodex();
    act(() => surfaces().focus());
    press("u");
    expect(p.install.open).toHaveBeenCalledWith("codex");
    press("p");
    expect(p.install.open).toHaveBeenLastCalledWith("codex", { readOnly: true });
    const body = within(detail()).getByRole("group", { name: "Codex detail" });
    act(() => body.focus());
    press("u", body);
    expect(p.install.open).toHaveBeenCalledTimes(3);
  });

  it("does not update while target changes are still being saved", () => {
    const { props: p } = renderCodex({ settingsSaveStatus: "saving" });
    act(() => surfaces().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
    expect(hint(/update/).getAttribute("title")).toBe("saving target changes");
  });

  it("explains a missing workspace and offers no update", () => {
    const { props: p } = renderCodex({ workspaceValid: false, overview: overviewOf({}) });
    expect(detail().textContent).toContain("No valid workspace installed");
    // The runtime heading carries the verdict; no row restates it under a heading that says something else.
    expect(detail().textContent).toContain("runtime · no valid workspace");
    expect(facts()).not.toHaveProperty("runtime");
    expect(facts()).not.toHaveProperty("rules");
    act(() => surfaces().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
  });

  it("waits for the settings before it lists anything", () => {
    renderCodex({ appSettings: null });
    expect(screen.getByRole("region", { name: "Codex surfaces" }).textContent).toContain("loading settings…");
    expect(screen.queryByRole("option")).toBeNull();
    expect(detail().querySelector(".pane-title")!.textContent).toContain("detail");
  });

  it("shows the review as one pane and the strip in place of the pair while it is open", () => {
    const flow = flowOf([op("codex_rules", "update")], { label: "update codex", surfaces: ["codex_rules"] });
    const install = installScreenOf(flow, "codex");
    renderCodex({ install });
    const review = screen.getByRole("region", { name: "Codex install review" });
    expect(review.className).toContain("review");
    expect(within(review).getAllByRole("region").map(pane => pane.getAttribute("aria-label")).at(-1)).toBe("Output");
    expect(within(review).getAllByRole("region")).toHaveLength(2);
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Codex surfaces" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("grid", { name: "Install plan" }), { key: "y" });
    expect(install.apply).toHaveBeenCalledTimes(1);
  });

  it("shows the Claude runtime from its sync flags", () => {
    renderInFrame(<ClaudeView {...props()} runtimeHealth={CLAUDE_HEALTH} />);
    const claude = screen.getByRole("region", { name: "Claude detail" });
    expect(claude.textContent).toContain("runtime · diverged");
    expect(facts(claude)).toMatchObject({ agents: "diverged · 5/6", "claude cli": "available" });
    expect(claude.textContent).not.toContain("Claude CLI available");
  });
});

describe("OpenCodeView model override", () => {
  const OPENCODE_HEALTH = { status: "synced", tui_status: "synced", agent_mismatches: [], warnings: [], cli: null, config_status: "synced", config_diverged_keys: [], rules_status: "synced", playwright_mcp_version: null, bundled_agent_count: 3, installed_bundled_agent_count: 3, default_agent: "build", autoupdate: "true", summary: "ok", next_action: "" } as unknown as OpenCodeRuntimeHealth;
  const BUNDLED: OpenCodeModelSelection = {
    model: "anthropic/claude-sonnet-4-5",
    small_model: "anthropic/claude-haiku-4-5",
    subagent_model: "",
    model_source: "bundled default",
    small_model_source: "bundled default",
    subagent_source: "bundled default",
  };
  const MODELS = ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "openai/gpt-5"];

  function backend({ saveResult = "Saved model selection", initial = BUNDLED, models = MODELS, warning = null }: { saveResult?: string; initial?: OpenCodeModelSelection; models?: string[]; warning?: string | null } = {}) {
    let selection = initial;
    invokeMock.mockImplementation(async (command: string, args?: { model?: string; smallModel?: string; subagentModel?: string | null }) => {
      switch (command) {
        case "read_opencode_model_selection":
          return selection;
        case "list_available_opencode_models":
          return { models, warning };
        case "update_opencode_model_selection": {
          const subagent = args!.subagentModel ?? "";
          // Like the backend: only a value that differs from the bundled default is an override.
          selection = {
            model: args!.model!,
            small_model: args!.smallModel!,
            subagent_model: subagent,
            model_source: args!.model === BUNDLED.model ? "bundled default" : "override",
            small_model_source: args!.smallModel === BUNDLED.small_model ? "bundled default" : "override",
            subagent_source: subagent ? "override" : "bundled default",
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

  const model = () => screen.getByLabelText("model") as HTMLSelectElement;
  const subagent = () => screen.getByLabelText("subagent model") as HTMLSelectElement;
  const paneBody = () => screen.getByRole("region", { name: "OpenCode detail" }).querySelector(".pane-body") as HTMLElement;
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

    const detailPane = screen.getByRole("region", { name: "OpenCode detail" });
    act(() => (detailPane.querySelector(".pane-body") as HTMLElement).focus());
    const save = hint(/save model/);
    expect(save.getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(model(), { target: { value: "openai/gpt-5" } });
    expect(hint(/save model/).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(hint(/save model/));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", {
      model: "openai/gpt-5",
      smallModel: "anthropic/claude-haiku-4-5",
      subagentModel: null,
    }));
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
    expect(await within(detailPane).findByText("Saved model selection")).toBeTruthy();
  });

  it("reloads the model list with R, leaving m to the rules file in the same pane", async () => {
    backend();
    renderOpenCode();
    await waitFor(() => expect((screen.getByLabelText("model") as HTMLSelectElement).tagName).toBe("SELECT"));
    const body = screen.getByRole("region", { name: "OpenCode detail" }).querySelector(".pane-body") as HTMLElement;
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
    const detailPane = screen.getByRole("region", { name: "OpenCode detail" });
    act(() => (detailPane.querySelector(".pane-body") as HTMLElement).focus());
    // The status bar follows focus on its own schedule; under a loaded test run it can lag a tick.
    await waitFor(() => expect(hint(/save model/).getAttribute("title")).toBe("Must be provider/model format"));
    expect(detailPane.textContent).toContain("opencode models: unavailable");
  });

  it("does not load models without a valid workspace", () => {
    backend();
    const merged = props({ workspaceValid: false, overview: overviewOf({}) });
    renderInFrame(<OpenCodeView {...merged} runtimeHealth={null} onModelUpdated={vi.fn()} />);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("model")).toBeNull();
  });

  describe("subagent model", () => {
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
      }));
      await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(subagent().value).toBe("openai/gpt-5"));
      // Only what the user changed is an override: the main models keep following the bundled default.
      expect(sourceLines().map(line => line.split(" · ")[0])).toEqual(["source: bundled default", "source: bundled default", "source: override"]);
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

  describe("source and state", () => {
    it("shows the bundled default as applied when the installed config matches", async () => {
      backend();
      renderOpenCode();
      await loaded();
      await waitFor(() => expect(sourceLines()).toHaveLength(3));
      expect(sourceLines()).toEqual([
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
      ]);
    });

    it("shows an override as pending apply, with the update key, while the installed config differs", async () => {
      backend({ initial: { ...BUNDLED, model: "openai/gpt-5", model_source: "override" } });
      renderOpenCode(vi.fn(), diverged("model"));
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      await waitFor(() => expect(sourceLines()).toHaveLength(3));
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
      await waitFor(() => expect(sourceLines()).toHaveLength(3));
      expect(sourceLines()).toEqual([
        "source: bundled default · state: applied",
        "source: bundled default · state: applied",
        "source: override · state: pending apply (u to update)",
      ]);
    });

    it("is pending everywhere while nothing is installed, and says no state while health is unknown", async () => {
      backend();
      renderOpenCode(vi.fn(), { ...OPENCODE_HEALTH, config_status: "missing" } as OpenCodeRuntimeHealth);
      await waitFor(() => expect(sourceLines()).toHaveLength(3));
      expect(sourceLines().every(line => line.endsWith("state: pending apply (u to update)"))).toBe(true);
      cleanup();

      backend();
      renderOpenCode(vi.fn(), null as unknown as OpenCodeRuntimeHealth);
      await waitFor(() => expect(sourceLines()).toHaveLength(3));
      expect(sourceLines()).toEqual(["source: bundled default", "source: bundled default", "source: bundled default"]);
    });
  });

  describe("reset", () => {
    const OVERRIDE: OpenCodeModelSelection = { model: "openai/gpt-5", small_model: "anthropic/claude-haiku-4-5", subagent_model: "anthropic/claude-haiku-4-5", model_source: "override", small_model_source: "bundled default", subagent_source: "override" };

    it("deletes the override with x and returns every row to the bundled default", async () => {
      backend({ initial: OVERRIDE });
      const { onModelUpdated } = renderOpenCode();
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      const body = paneBody();
      act(() => body.focus());
      expect(hint(/reset model/).getAttribute("aria-disabled")).toBeNull();

      fireEvent.keyDown(body, { key: "x" });

      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("reset_opencode_model_selection"));
      await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(model().value).toBe("anthropic/claude-sonnet-4-5"));
      expect(subagent().value).toBe("");
      expect(await within(screen.getByRole("region", { name: "OpenCode detail" })).findByText(/Model override removed/)).toBeTruthy();
      await waitFor(() => expect(sourceLines()[0]).toContain("source: bundled default"));
      expect(sourceLines()[2]).toContain("source: bundled default");
    });

    it("drops unsaved edits along with the override", async () => {
      backend({ initial: OVERRIDE });
      renderOpenCode();
      await waitFor(() => expect(model().value).toBe("openai/gpt-5"));
      fireEvent.change(model(), { target: { value: "anthropic/claude-haiku-4-5" } });
      const body = paneBody();
      act(() => body.focus());
      fireEvent.keyDown(body, { key: "x" });
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

describe("HarnessPage output strip progress", () => {
  const progress: ApplyProgress = {
    task: "apply_setup",
    phase: "apply",
    done: 2,
    total: 5,
    file: "~/.codex/AGENTS.md",
  };

  beforeEach(() => outputStripProps.mockClear());

  it("hands the backend's progress to the strip", () => {
    renderCodex({ wsRunning: "update codex", wsProgress: progress });
    expect(outputStripProps).toHaveBeenLastCalledWith(expect.objectContaining({ progress }));
  });

  it("hands it null until the backend reports", () => {
    renderCodex({ wsRunning: "update codex", wsProgress: null });
    expect(outputStripProps).toHaveBeenLastCalledWith(expect.objectContaining({ progress: null }));
  });
});
