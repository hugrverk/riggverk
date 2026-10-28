import { describe, expect, it } from "vitest";
import type { OverviewEntry, OverviewId } from "../hooks/useInstallationOverview";
import { installationStatus, overviewOf, surfaceStatus } from "../test/pageFixtures";
import type { AppSettings, InstallAgent, InstallationStatus } from "../types";
import { ALL_UP_TO_DATE, decideCountsByHarness, harnessUiItems, updateAllDisabledReason } from "./shellSummary";

const SETTINGS: Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids"> = {
  enabled_harness_ids: ["codex", "claude"],
  enabled_target_ids: ["codex_rules", "codex_config", "claude_rules"],
};

const rulesConflict: InstallationStatus = installationStatus("conflict", [
  {
    ...surfaceStatus("claude_rules", "conflict"),
    rules: { layout: "legacy", refinement_lines: 0, user_managed: false, conflict_reason: "legacy_diverged" },
  },
]);

const codexKeysDiffer: InstallationStatus = installationStatus("current", [
  {
    ...surfaceStatus("codex_config", "current"),
    codex_config: { kept: [], differing: [{ key: "approvals_reviewer", value: "user" }] },
  },
]);

const IDLE = { dataFolderOk: true, busyLabel: null, settingsSaving: false };

function overview(statuses: Partial<Record<OverviewId, InstallationStatus | null>>) {
  return overviewOf(statuses);
}

describe("harnessUiItems", () => {
  it("turns an edited rules file into a decision with its sub-line", () => {
    const entry = overview({ claude: rulesConflict }).entries.claude;
    const items = harnessUiItems("claude", entry, SETTINGS, true);
    const rules = items.find(item => item.surface === "claude_rules")!;
    expect(rules).toMatchObject({ owner: "claude", state: "decide", subline: "Your file differs from every shipped version" });
  });

  it("turns Codex keys that differ from Riggverk's value into a decision", () => {
    const entry = overview({ codex: codexKeysDiffer }).entries.codex;
    const items = harnessUiItems("codex", entry, SETTINGS, true);
    expect(items.find(item => item.surface === "codex_config")).toMatchObject({
      state: "decide",
      subline: "approvals_reviewer differs from Riggverk's value",
    });
  });

  it("leaves an item uncounted while the folder is unusable", () => {
    const entry = overview({ claude: rulesConflict }).entries.claude;
    const items = harnessUiItems("claude", entry, SETTINGS, false);
    expect(items.every(item => item.state === null)).toBe(true);
  });

  it("counts a turned-off surface as off, and leaves everything uncounted after a failed fetch", () => {
    const fetched = overview({ codex: installationStatus("current") }).entries.codex;
    expect(harnessUiItems("codex", fetched, SETTINGS, true).some(item => item.state === "off")).toBe(true);
    const failed: OverviewEntry = { id: "codex", status: null, loading: false, error: "boom" };
    expect(harnessUiItems("codex", failed, SETTINGS, true).every(item => item.state === null)).toBe(true);
  });
});

describe("decideCountsByHarness", () => {
  it("counts the decisions of each enabled agent and leaves out agents without any", () => {
    const harnesses: InstallAgent[] = ["codex", "claude"];
    const counts = decideCountsByHarness(
      overview({ workspace: installationStatus("current"), codex: installationStatus("current"), claude: rulesConflict }),
      harnesses,
      SETTINGS,
      true,
    );
    expect(counts).toEqual({ claude: 1 });
    expect(
      decideCountsByHarness(overview({ codex: codexKeysDiffer, claude: rulesConflict }), harnesses, SETTINGS, true),
    ).toEqual({ codex: 1, claude: 1 });
  });

  it("is empty without settings", () => {
    expect(decideCountsByHarness(overview({ claude: rulesConflict }), ["claude"], null, true)).toEqual({});
  });
});

describe("updateAllDisabledReason", () => {
  const current = installationStatus("current");

  it("is open when any entry has something to apply, and a conflict counts", () => {
    expect(updateAllDisabledReason(overview({ workspace: current, codex: installationStatus("update_available") }), IDLE)).toBe(false);
    expect(updateAllDisabledReason(overview({ workspace: current, claude: installationStatus("not_installed") }), IDLE)).toBe(false);
    expect(updateAllDisabledReason(overview({ workspace: current, claude: rulesConflict }), IDLE)).toBe(false);
  });

  it("says everything is up to date when every entry is current or unavailable", () => {
    expect(updateAllDisabledReason(overview({ workspace: current, codex: current, cursor: installationStatus("unavailable") }), IDLE)).toBe(
      ALL_UP_TO_DATE,
    );
  });

  it("gives the unusable folder, a running task and unsaved target changes priority, in that order", () => {
    const waiting = overview({ codex: installationStatus("update_available") });
    expect(updateAllDisabledReason(waiting, { dataFolderOk: false, busyLabel: "update", settingsSaving: true })).toBe("workspace folder unusable");
    expect(updateAllDisabledReason(waiting, { dataFolderOk: true, busyLabel: "update", settingsSaving: true })).toBe("update is running");
    expect(updateAllDisabledReason(waiting, { dataFolderOk: true, busyLabel: null, settingsSaving: true })).toBe("Saving target changes…");
  });

  it("waits while status is still loading or has not started", () => {
    expect(updateAllDisabledReason(overview({}), IDLE)).toBe("Checking status…");
    const loading = overview({ codex: current });
    loading.entries.workspace = { id: "workspace", status: null, loading: true, error: null };
    expect(updateAllDisabledReason(loading, IDLE)).toBe("Checking status…");
  });

  it("does not claim everything is up to date when a check failed", () => {
    const failed = overview({ workspace: current });
    failed.entries.codex = { id: "codex", status: null, loading: false, error: "boom" };
    expect(updateAllDisabledReason(failed, IDLE)).toBe("Couldn't check every agent. Try Check again.");
    // Something else to apply still opens the review.
    failed.entries.claude = { id: "claude", status: installationStatus("update_available"), loading: false, error: null };
    expect(updateAllDisabledReason(failed, IDLE)).toBe(false);
  });
});
