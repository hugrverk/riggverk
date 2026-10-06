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
import type { AgentTargetMeta, ClaudeRuntimeHealth, CodexRuntimeHealth, OpenCodeRuntimeHealth } from "../types";
import { ClaudeView } from "./ClaudeView";
import { CodexView } from "./CodexView";
import { OpenCodeView } from "./OpenCodeView";
import type { HarnessViewProps } from "./pageTypes";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/codex-rules.md" },
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
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    canRunReleaseCheck: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

function renderCodex(overrides: Partial<HarnessViewProps> = {}) {
  const merged = props(overrides);
  return { props: merged, ...renderInFrame(<CodexView {...merged} runtimeHealth={CODEX_HEALTH} />) };
}

function targets() {
  return screen.getByRole("listbox", { name: "Codex targets" });
}

function press(key: string, target: Element) {
  fireEvent.keyDown(target, { key });
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe("HarnessPage", () => {
  it("shows the four panes: targets, surfaces, runtime and output", () => {
    renderCodex();
    const page = screen.getByRole("region", { name: "Codex" });
    expect(within(page).getAllByRole("region").map(pane => pane.getAttribute("aria-label"))).toEqual([
      "Codex targets",
      "Codex surfaces",
      "Codex runtime",
      "Output",
    ]);
  });

  it("lists the targets as a multi-select with a text marker, and Space toggles the one under the cursor", () => {
    const { props: p } = renderCodex();
    expect(targets().getAttribute("aria-multiselectable")).toBe("true");
    const rows = within(targets()).getAllByRole("option");
    expect(rows.map(row => [row.getAttribute("aria-selected"), row.querySelector(".nm")!.textContent])).toEqual([
      ["true", "[x] codex rules"],
      ["false", "[ ] codex config"],
    ]);
    act(() => targets().focus());
    press(" ", targets());
    expect(p.onToggleTarget).toHaveBeenCalledWith("codex_rules");
    press("j", targets());
    press(" ", targets());
    expect(p.onToggleTarget).toHaveBeenLastCalledWith("codex_config");
    fireEvent.click(rows[1]!);
    expect(p.onToggleTarget).toHaveBeenCalledTimes(3);
  });

  it("offers the toggle as a button too", () => {
    const { props: p } = renderCodex();
    fireEvent.click(within(screen.getByRole("region", { name: "Codex targets" })).getByRole("button", { name: /toggle/ }));
    expect(p.onToggleTarget).toHaveBeenCalledWith("codex_rules");
  });

  it("shows autosave progress and failure next to the targets", () => {
    const { rerenderFrame, props: p } = renderCodex({ settingsSaveStatus: "pending" });
    const title = () => screen.getByRole("region", { name: "Codex targets" }).querySelector(".pane-title")!.textContent;
    expect(title()).toContain("autosaving");
    rerenderFrame(<CodexView {...p} settingsSaveStatus="error" runtimeHealth={CODEX_HEALTH} />);
    expect(title()).toContain("not saved");
  });

  it("lists surfaces whose target is off as off, and the others with their state", () => {
    // codex_config is off by default; codex_agents is on but has no status row yet.
    renderCodex();
    const surfaces = within(screen.getByRole("listbox", { name: "Codex surfaces" })).getAllByRole("option");
    expect(surfaces.map(row => [row.querySelector(".nm")!.textContent!.trim().split(" ")[0], row.querySelector(".meta")!.textContent!.trim()])).toEqual([
      ["config", "· off"],
      ["agents", "· unknown"],
      ["rules", "◐ update"],
      ["skills", "● current"],
    ]);
  });

  it("shows the runtime facts of the harness", () => {
    renderCodex();
    const runtime = screen.getByRole("region", { name: "Codex runtime" });
    expect(runtime.querySelector(".pane-title")!.textContent).toContain("diverged");
    expect(runtime.textContent).toContain("skills");
    expect(runtime.textContent).toContain("synced · 17/18");
    expect(runtime.textContent).toContain("on-request");
    expect(runtime.textContent).toContain("Update Codex.");
  });

  it("opens the install review for this harness with u, and a read-only preview with p", () => {
    const { props: p } = renderCodex();
    act(() => targets().focus());
    press("u", targets());
    expect(p.install.open).toHaveBeenCalledWith("codex");
    press("p", targets());
    expect(p.install.open).toHaveBeenLastCalledWith("codex", { readOnly: true });
  });

  it("does not update while target changes are still being saved", () => {
    const { props: p } = renderCodex({ settingsSaveStatus: "saving" });
    act(() => targets().focus());
    press("u", targets());
    expect(p.install.open).not.toHaveBeenCalled();
    const update = within(screen.getByRole("region", { name: "Codex surfaces" })).getByRole("button", { name: /update/ });
    expect(update.getAttribute("title")).toBe("saving target changes");
  });

  it("explains a missing workspace and offers no update", () => {
    const { props: p } = renderCodex({ workspaceValid: false, overview: overviewOf({}) });
    expect(screen.getByRole("region", { name: "Codex surfaces" }).textContent).toContain("No valid workspace installed");
    act(() => targets().focus());
    press("u", targets());
    expect(p.install.open).not.toHaveBeenCalled();
  });

  it("shows the review in place of the panes while it is open", () => {
    const flow = flowOf([op("codex_rules", "update")], { label: "update codex", surfaces: ["codex_rules"] });
    const install = installScreenOf(flow, "codex");
    renderCodex({ install });
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Codex targets" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("grid", { name: "Install plan" }), { key: "y" });
    expect(install.apply).toHaveBeenCalledTimes(1);
  });

  it("shows the Claude runtime from its sync flags", () => {
    renderInFrame(<ClaudeView {...props()} runtimeHealth={CLAUDE_HEALTH} />);
    const runtime = screen.getByRole("region", { name: "Claude runtime" });
    expect(runtime.querySelector(".pane-title")!.textContent).toContain("diverged");
    expect(runtime.textContent).toContain("diverged · 5/6");
    expect(runtime.textContent).toContain("claude cli");
  });
});

describe("OpenCodeView model override", () => {
  const OPENCODE_HEALTH = { status: "synced", tui_status: "synced", agent_mismatches: [], warnings: [], bundled_agent_count: 3, installed_bundled_agent_count: 3, default_agent: "build", autoupdate: "true", summary: "ok", next_action: "" } as unknown as OpenCodeRuntimeHealth;

  function backend(saveResult = "Saved model selection") {
    let selection = { model: "anthropic/claude-sonnet-4-5", small_model: "anthropic/claude-haiku-4-5" };
    invokeMock.mockImplementation(async (command: string, args?: { model?: string; smallModel?: string }) => {
      switch (command) {
        case "read_opencode_model_selection":
          return selection;
        case "list_available_opencode_models":
          return { models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "openai/gpt-5"], warning: null };
        case "update_opencode_model_selection":
          selection = { model: args!.model!, small_model: args!.smallModel! };
          return saveResult;
        default:
          throw new Error(`unexpected ${command}`);
      }
    });
  }

  function renderOpenCode(onModelUpdated = vi.fn()) {
    const merged = props({ appSettings: settingsOf() });
    renderInFrame(<OpenCodeView {...merged} runtimeHealth={OPENCODE_HEALTH} onModelUpdated={onModelUpdated} />);
    return { onModelUpdated };
  }

  it("keeps working: loads the selection, edits it in place and saves it", async () => {
    backend();
    const { onModelUpdated } = renderOpenCode();
    // The field is a text input until the model list arrives, then a select: look it up again each time.
    const model = () => screen.getByLabelText("model") as HTMLSelectElement;
    await waitFor(() => expect(model().tagName === "SELECT" && model().value).toBe("anthropic/claude-sonnet-4-5"));
    const small = screen.getByLabelText("small model") as HTMLSelectElement;
    expect(small.value).toBe("anthropic/claude-haiku-4-5");

    const runtime = screen.getByRole("region", { name: "OpenCode runtime" });
    const save = within(runtime).getByRole("button", { name: /save model/ });
    expect(save.getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(model(), { target: { value: "openai/gpt-5" } });
    expect(within(runtime).getByRole("button", { name: /save model/ }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(within(runtime).getByRole("button", { name: /save model/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_opencode_model_selection", {
      model: "openai/gpt-5",
      smallModel: "anthropic/claude-haiku-4-5",
    }));
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
    expect(await within(runtime).findByText("Saved model selection")).toBeTruthy();
  });

  it("saves from the keyboard with s once there is a change", async () => {
    backend();
    const { onModelUpdated } = renderOpenCode();
    const model = () => screen.getByLabelText("model") as HTMLSelectElement;
    await waitFor(() => expect(model().tagName === "SELECT" && model().value).toBe("anthropic/claude-sonnet-4-5"));
    const body = screen.getByRole("region", { name: "OpenCode runtime" }).querySelector(".pane-body") as HTMLElement;
    act(() => body.focus());
    fireEvent.keyDown(body, { key: "s" });
    expect(onModelUpdated).not.toHaveBeenCalled();
    fireEvent.change(model(), { target: { value: "openai/gpt-5" } });
    fireEvent.keyDown(body, { key: "s" });
    await waitFor(() => expect(onModelUpdated).toHaveBeenCalledTimes(1));
  });

  it("falls back to text inputs when nothing is known and rejects a model without a provider", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "read_opencode_model_selection") return { model: "", small_model: "" };
      if (command === "list_available_opencode_models") return { models: [], warning: "opencode models: unavailable" };
      throw new Error(`unexpected ${command}`);
    });
    renderOpenCode();
    const model = () => screen.getByLabelText("model") as HTMLInputElement;
    // No model list and nothing configured: the fields stay text inputs.
    await screen.findByText("opencode models: unavailable");
    expect(model().tagName).toBe("INPUT");
    fireEvent.change(model(), { target: { value: "gpt-5" } });
    expect(screen.getByRole("alert").textContent).toBe("Must be provider/model format");
    expect(model().getAttribute("aria-invalid")).toBe("true");
    const runtime = screen.getByRole("region", { name: "OpenCode runtime" });
    expect(within(runtime).getByRole("button", { name: /save model/ }).getAttribute("title")).toBe("Must be provider/model format");
    expect(runtime.textContent).toContain("opencode models: unavailable");
  });

  it("does not load models without a valid workspace", () => {
    backend();
    const merged = props({ workspaceValid: false, overview: overviewOf({}) });
    renderInFrame(<OpenCodeView {...merged} runtimeHealth={null} onModelUpdated={vi.fn()} />);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("model")).toBeNull();
  });
});
