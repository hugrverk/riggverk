import { describe, expect, it } from "vitest";
import type { OverviewId } from "../hooks/useInstallationOverview";
import { installationStatus, overviewOf, postureOf, surfaceStatus } from "../test/pageFixtures";
import type { AppSettings, InstallAgent, InstallationStatus } from "../types";
import { disabledHarnesses, listText, overviewSummaryModel, worthALook } from "./overviewModel";

const SETTINGS: Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids"> = {
  enabled_harness_ids: ["codex", "claude", "cursor"],
  enabled_target_ids: ["codex_rules", "codex_agents", "claude_rules", "claude_agents", "cursor_setup"],
};
const HARNESSES: InstallAgent[] = ["codex", "claude", "cursor"];

const WORKSPACE = installationStatus("current", [surfaceStatus("workspace_bundle", "current")]);
const rulesConflict: InstallationStatus = installationStatus("conflict", [
  {
    ...surfaceStatus("claude_rules", "conflict"),
    rules: { layout: "legacy", refinement_lines: 0, user_managed: false, conflict_reason: "legacy_diverged" },
  },
  surfaceStatus("claude_agents", "current"),
  surfaceStatus("skills", "current"),
]);

function summaryFor(statuses: Partial<Record<OverviewId, InstallationStatus | null>>, overrides: { dataFolderOk?: boolean; error?: string | null } = {}) {
  return overviewSummaryModel({
    overview: overviewOf(statuses),
    settings: SETTINGS,
    enabledHarnessIds: HARNESSES,
    dataFolderOk: overrides.dataFolderOk ?? true,
    diagnostics: { error: overrides.error ?? null },
  });
}

describe("overviewSummaryModel headline and counts", () => {
  it("says the setup works and counts only the states that are not zero", () => {
    const summary = summaryFor({
      workspace: WORKSPACE,
      codex: installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("skills", "current")]),
      claude: rulesConflict,
      cursor: installationStatus("update_available", [surfaceStatus("cursor_agents", "update_available", "2 to update")]),
    });
    expect(summary.headline).toBe("Your setup works.");
    expect(summary.parts.map(part => part.state)).toEqual(expect.arrayContaining(["ok", "ready", "decide"]));
    expect(summary.parts.every(part => part.count > 0)).toBe(true);
    // The shared skills surface counts once, not once per agent.
    expect(summary.counts).toMatchObject({ ok: 4, decide: 1, ready: 1, off: 2 });
  });

  it("says everything is set up when nothing waits for a decision, a fix or an update", () => {
    const current = installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("skills", "current")]);
    const summary = summaryFor({
      workspace: WORKSPACE,
      codex: current,
      claude: installationStatus("current", [surfaceStatus("claude_rules", "current"), surfaceStatus("claude_agents", "current"), surfaceStatus("skills", "current")]),
      cursor: installationStatus("current", [surfaceStatus("cursor_agents", "current"), surfaceStatus("skills", "current"), surfaceStatus("cursor_mcp", "current")]),
    });
    expect(summary.headline).toBe("Everything is set up.");
    expect(summary.parts.map(part => part.state)).not.toContain("decide");
    expect(summary.parts.map(part => part.state)).not.toContain("ready");
  });

  it("says nothing is set up yet on a fresh profile, even with an agent setting that is off", () => {
    const fresh = (surfaces: Parameters<typeof surfaceStatus>[0][]) =>
      installationStatus("not_installed", surfaces.map(surface => surfaceStatus(surface, "not_installed")));
    const summary = summaryFor({
      workspace: WORKSPACE,
      codex: fresh(["codex_rules", "codex_agents", "skills"]),
      claude: fresh(["claude_rules", "claude_agents", "skills"]),
      cursor: fresh(["cursor_agents", "skills", "cursor_mcp"]),
    });
    expect(summary.headline).toBe("Nothing is set up yet.");
    // Install wording for the first install; the state stays `ready`.
    expect(summary.parts.find(part => part.state === "ready")).toMatchObject({ count: 7, text: "7 ready to install" });
    const badge = summary.cards.find(card => card.harness === "codex")!.badge;
    expect(badge).toEqual({ state: "ready", text: "Ready to install" });
  });

  it("keeps update wording once something is installed", () => {
    const summary = summaryFor({
      workspace: WORKSPACE,
      codex: installationStatus("update_available", [surfaceStatus("codex_rules", "update_available"), surfaceStatus("codex_agents", "current"), surfaceStatus("skills", "current")]),
    });
    expect(summary.parts.find(part => part.state === "ready")!.text).toMatch(/update/);
    expect(summary.cards.find(card => card.harness === "codex")!.badge).toEqual({ state: "ready", text: "Update ready" });
  });

  it("says Checking while no status has arrived, and names an unusable folder", () => {
    expect(summaryFor({}).headline).toBe("Checking your setup…");
    const unusable = summaryFor({}, { dataFolderOk: false, error: "the folder is a symlink" });
    expect(unusable.headline).toBe("Riggverk can't use its folder.");
    expect(unusable.counts.fix).toBe(1);
    expect(unusable.workspace.subline).toBe("the folder is a symlink");
  });

  it("counts a failed check apart from the states", () => {
    const overview = overviewOf({ workspace: WORKSPACE, codex: null });
    overview.entries.codex = { id: "codex", status: null, loading: false, error: "boom" };
    const summary = overviewSummaryModel({
      overview,
      settings: SETTINGS,
      enabledHarnessIds: HARNESSES,
      dataFolderOk: true,
      diagnostics: { error: null },
    });
    expect(summary.failedChecks).toBe(1);
    expect(summary.cards.find(card => card.harness === "codex")!.rows.every(row => row.state === null)).toBe(true);
  });
});

/** The Overview card of one agent, as the summary builds it. */
function cardFor(
  harness: InstallAgent,
  overview: ReturnType<typeof overviewOf>,
  options: { dataFolderOk?: boolean; runtime?: Parameters<typeof overviewSummaryModel>[0]["runtime"] } = {},
) {
  return overviewSummaryModel({
    overview,
    settings: SETTINGS,
    enabledHarnessIds: [harness],
    dataFolderOk: options.dataFolderOk ?? true,
    diagnostics: { error: null },
    runtime: options.runtime,
  }).cards[0]!;
}

describe("the agent card", () => {
  it("shows the decision in the badge and the urgent row's sentence", () => {
    const card = cardFor("claude", overviewOf({ claude: rulesConflict }));
    expect(card.badge).toEqual({ state: "decide", text: "1 to decide" });
    expect(card.rows.map(row => row.label)).toEqual(["Rules", "Agents", "Skills", "Settings"]);
    expect(card.rows.find(row => row.label === "Rules")).toMatchObject({ state: "decide", text: "needs decision" });
    expect(card.rows.find(row => row.label === "Settings")).toMatchObject({ state: "off", text: "not managed" });
    expect(card.notes).toEqual(["Your file differs from every shipped version"]);
  });

  it("adds a runtime sentence only when the agent reads as up to date and the runtime warns", () => {
    const current = installationStatus("current", [surfaceStatus("claude_rules", "current"), surfaceStatus("claude_agents", "current"), surfaceStatus("skills", "current")]);
    const diverged = {
      harness: "claude" as const,
      health: { rules_synced: false, agents_synced: true, skills_synced: true } as never,
    };
    const ok = cardFor("claude", overviewOf({ claude: current }), { runtime: { claude: diverged } });
    expect(ok.notes).toEqual(["Runtime check: diverged"]);
    const decided = cardFor("claude", overviewOf({ claude: rulesConflict }), { runtime: { claude: diverged } });
    expect(decided.notes).toEqual(["Your file differs from every shipped version"]);
  });

  it("does not count an agent while the workspace folder is unusable", () => {
    const card = cardFor("codex", overviewOf({}), { dataFolderOk: false });
    expect(card.badge).toBeNull();
    expect(card.notes).toEqual(["Needs the workspace folder"]);
  });
});

describe("worthALook", () => {
  const risky = postureOf("codex", [["codex_approvals_never", "risky"], ["codex_network_on", "risky"], ["config_only", "not_covered"]]);
  const advice = postureOf("claude", [["claude_sandbox_off", "advice"]]);

  it("lists only risky findings of enabled agents, one row each, with the rest counted", () => {
    const look = worthALook({ codex: risky, claude: advice, cursor: postureOf("cursor", [["cursor_sandbox_off", "risky"]]) }, ["codex", "claude"]);
    expect(look.count).toBe(2);
    expect(look.rows).toEqual([{ harness: "codex", label: "Codex", text: "approval_policy is never + 1 more" }]);
  });

  it("is empty without risky findings", () => {
    expect(worthALook({ claude: advice }, ["claude"])).toEqual({ count: 0, rows: [] });
  });
});

describe("small helpers", () => {
  it("lists the agents that are off in sidebar order and writes them out", () => {
    expect(disabledHarnesses(["codex", "claude", "opencode"])).toEqual(["cursor", "copilot", "pi", "kilo"]);
    expect(listText(["Cursor", "Copilot", "Pi", "Kilo"])).toBe("Cursor, Copilot, Pi and Kilo");
    expect(listText(["Kilo"])).toBe("Kilo");
  });
});
