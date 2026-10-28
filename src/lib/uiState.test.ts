import { describe, expect, it } from "vitest";
import type { RulesStatus, SetupSurfaceId } from "../types";
import type { CodexConfigModel } from "./codexConfig";
import type { FileConflictModel } from "./fileConflicts";
import { rulesModel } from "./rulesView";
import {
  aggregateState,
  harnessBadge,
  overviewHeadline,
  postureMark,
  runtimeSubline,
  summaryParts,
  surfaceUiState,
  tally,
  UI_STATE_LABEL,
  UI_STATE_PRECEDENCE,
  UI_STATE_SUMMARY_ORDER,
  type UiItem,
  type UiState,
} from "./uiState";

const REVIEWER = { key: "approvals_reviewer", value: "auto_review" };
const SANDBOX = { key: "sandbox_mode", value: "read-only" };

function rules(overrides: Partial<RulesStatus> = {}): RulesStatus {
  return { layout: "block", refinement_lines: 0, user_managed: false, ...overrides };
}

function files(overrides: Partial<FileConflictModel> = {}): FileConflictModel {
  return { surface: "skills", units: [], conflicts: 0, kept: 0, keptUpdates: 0, more: 0, ...overrides };
}

function codex(overrides: Partial<CodexConfigModel> = {}): CodexConfigModel {
  return { kept: [], differing: [], ...overrides };
}

function item(surface: SetupSurfaceId, state: UiState | null, owner: UiItem["owner"] = "codex"): UiItem {
  return { key: `${owner}:${surface}`, owner, surface, state, subline: null };
}

function counts(overrides: Partial<Record<UiState, number>> = {}): Record<UiState, number> {
  return { ok: 0, ready: 0, decide: 0, yours: 0, fix: 0, off: 0, ...overrides };
}

describe("surfaceUiState: one case per mapping row", () => {
  it("does not count a harness surface while the workspace folder is unusable", () => {
    expect(surfaceUiState({ display: "current", dataFolderOk: false })).toEqual({ state: null, subline: "Needs the workspace folder" });
  });

  it("makes the unusable folder a fix on the workspace item, with the diagnostics error", () => {
    expect(surfaceUiState({ display: "unknown", dataFolderOk: false, workspaceItem: true, workspaceError: "path is a symlink" })).toEqual({
      state: "fix",
      subline: "path is a symlink",
    });
  });

  it("does not count an entry that is loading or unknown", () => {
    expect(surfaceUiState({ display: "unknown" })).toEqual({ state: null, subline: "Checking…" });
  });

  it("does not count an entry whose fetch failed, and says so instead of Checking", () => {
    expect(surfaceUiState({ display: "unknown", entryError: "boom" })).toEqual({
      state: null,
      subline: "Couldn't check. Try Check again.",
    });
  });

  it("needs a decision for edited files, with the count", () => {
    expect(surfaceUiState({ display: "update_available", files: files({ conflicts: 1 }) })).toEqual({ state: "decide", subline: "1 file you edited" });
    expect(surfaceUiState({ display: "conflict", files: files({ conflicts: 2 }) }).subline).toBe("2 files you edited");
  });

  it("needs a decision for a convertible rules conflict, worded by the reason", () => {
    const legacy = rulesModel("claude_rules", "conflict", rules({ layout: "legacy", conflict_reason: "legacy_diverged" }));
    const block = rulesModel("claude_rules", "conflict", rules({ conflict_reason: "base_block_edited" }));
    expect(surfaceUiState({ display: "conflict", rules: legacy })).toEqual({ state: "decide", subline: "Your file differs from every shipped version" });
    expect(surfaceUiState({ display: "conflict", rules: block })).toEqual({ state: "decide", subline: "You edited the managed block" });
  });

  it("needs a decision when enabled Codex keys differ, naming them", () => {
    expect(surfaceUiState({ display: "update_available", codexConfig: codex({ differing: [REVIEWER] }) })).toEqual({
      state: "decide",
      subline: "approvals_reviewer differs from Riggverk's value",
    });
    expect(surfaceUiState({ display: "update_available", codexConfig: codex({ differing: [REVIEWER, SANDBOX] }) }).subline).toBe(
      "approvals_reviewer and sandbox_mode differ from Riggverk's value",
    );
  });

  it("is a fix for malformed and blocked rules, with the reason", () => {
    const malformed = rulesModel("claude_rules", "conflict", rules({ conflict_reason: "malformed_markers", malformed_reason: "missing_end" }));
    const blocked = rulesModel("codex_rules", "conflict", rules({ conflict_reason: "masked_by_override" }));
    expect(surfaceUiState({ display: "conflict", rules: malformed })).toEqual({
      state: "fix",
      subline: "the base block markers are malformed: BEGIN marker has no matching END marker",
    });
    expect(surfaceUiState({ display: "conflict", rules: blocked }).state).toBe("fix");
    expect(surfaceUiState({ display: "conflict", rules: blocked }).subline).toContain("masks this one");
  });

  it("is a fix for any other conflict, with the backend detail", () => {
    expect(surfaceUiState({ display: "conflict", detail: "opencode.json has its own mcp entry" })).toEqual({
      state: "fix",
      subline: "opencode.json has its own mcp entry",
    });
  });

  it("is ready for an update or a missing install", () => {
    expect(surfaceUiState({ display: "update_available", detail: "2 to update" })).toEqual({ state: "ready", subline: "2 to update" });
    expect(surfaceUiState({ display: "not_installed" })).toEqual({ state: "ready", subline: "Not installed yet" });
    expect(surfaceUiState({ display: "update_available", rules: rulesModel("claude_rules", "update_available", rules()) }).state).toBe("ready");
    expect(surfaceUiState({ display: "not_installed", rules: rulesModel("claude_rules", "not_installed", rules({ layout: "absent" })) })).toEqual({
      state: "ready",
      subline: "Not installed yet",
    });
  });

  it("is yours for a rules file the user manages", () => {
    const managed = rulesModel("claude_rules", "current", rules({ user_managed: true }));
    expect(surfaceUiState({ display: "user_managed", rules: managed })).toEqual({
      state: "yours",
      subline: "You manage this file; base updates are waiting",
    });
  });

  it("is yours for kept files, with the updates waiting", () => {
    expect(surfaceUiState({ display: "user_managed", files: files({ kept: 2, keptUpdates: 1 }) })).toEqual({
      state: "yours",
      subline: "You manage 2 files; 1 update waiting",
    });
    expect(surfaceUiState({ display: "current", files: files({ kept: 1 }) })).toEqual({ state: "yours", subline: "You manage 1 file" });
  });

  it("is yours for a kept Codex key when the surface is current and nothing differs", () => {
    expect(surfaceUiState({ display: "current", codexConfig: codex({ kept: [REVIEWER] }) })).toEqual({
      state: "yours",
      subline: "You keep approvals_reviewer",
    });
  });

  it("is up to date when current, without a sub-line", () => {
    expect(surfaceUiState({ display: "current" })).toEqual({ state: "ok", subline: null });
    expect(surfaceUiState({ display: "current", rules: rulesModel("claude_rules", "current", rules()) })).toEqual({ state: "ok", subline: null });
  });

  it("is up to date with a sub-line when a kept Codex key stays and another key was updated", () => {
    expect(surfaceUiState({ display: "current", codexConfig: codex({ kept: [REVIEWER] }), codexOtherKeysUpdated: true })).toEqual({
      state: "ok",
      subline: "You keep approvals_reviewer",
    });
  });

  it("is not managed when the target is off, with the claude_config wording", () => {
    expect(surfaceUiState({ display: "off" })).toEqual({ state: "off", subline: "Not managed. Turn on to let Riggverk manage it." });
    expect(surfaceUiState({ display: "off", surface: "claude_config" }).subline).toBe(
      "Not managed. Claude Code keeps its default commit and PR attribution.",
    );
  });

  it("is not managed when unavailable", () => {
    expect(surfaceUiState({ display: "unavailable" })).toEqual({ state: "off", subline: "Unavailable on this system" });
  });
});

describe("surfaceUiState: precedence inside one surface", () => {
  it("lets a file conflict beat an available update", () => {
    expect(surfaceUiState({ display: "update_available", detail: "2 to update", files: files({ conflicts: 2 }) }).state).toBe("decide");
  });

  it("lets a decision beat a fix and a fix beat an update", () => {
    const malformed = rulesModel("claude_rules", "conflict", rules({ conflict_reason: "malformed_markers", malformed_reason: "missing_end" }));
    expect(surfaceUiState({ display: "conflict", rules: malformed, files: files({ conflicts: 1 }) }).state).toBe("decide");
    expect(surfaceUiState({ display: "update_available", rules: malformed }).state).toBe("fix");
  });

  it("lets an update beat kept files", () => {
    expect(surfaceUiState({ display: "update_available", files: files({ kept: 1 }) }).state).toBe("ready");
  });
});

describe("aggregateState", () => {
  it("follows the precedence and ignores nulls", () => {
    expect(aggregateState(["ok", "ready", "decide"])).toBe("decide");
    expect(aggregateState(["ok", "yours", "fix"])).toBe("fix");
    expect(aggregateState([null, "ok", "off"])).toBe("ok");
    expect(aggregateState([null, null])).toBeNull();
    expect(aggregateState([])).toBeNull();
  });
});

describe("harnessBadge", () => {
  it("counts the decisions and fixes of the harness", () => {
    const items = [item("codex_rules", "decide"), item("codex_agents", "decide"), item("codex_config", "ready")];
    expect(harnessBadge(items)).toEqual({ state: "decide", text: "2 to decide" });
    expect(harnessBadge([item("codex_rules", "fix"), item("codex_config", "ok")])).toEqual({ state: "fix", text: "1 to fix" });
  });

  it("names the other states", () => {
    expect(harnessBadge([item("codex_config", "ready"), item("codex_rules", "ok")])).toEqual({ state: "ready", text: "Update ready" });
    expect(harnessBadge([item("codex_config", "yours"), item("codex_rules", "ok")])).toEqual({ state: "yours", text: "Yours" });
    expect(harnessBadge([item("codex_config", "ok")])).toEqual({ state: "ok", text: "Up to date" });
    expect(harnessBadge([item("codex_config", "off")])).toEqual({ state: "off", text: "Not managed" });
  });

  it("has no badge when nothing is counted", () => {
    expect(harnessBadge([item("codex_config", null)])).toBeNull();
    expect(harnessBadge([])).toBeNull();
  });
});

describe("tally", () => {
  it("counts the shared skills surface once across three harnesses", () => {
    const items = [
      item("skills", "ready", "claude"),
      item("skills", "ready", "codex"),
      item("skills", "ready", "opencode"),
      item("codex_rules", "ok", "codex"),
    ];
    expect(tally(items)).toEqual(counts({ ready: 1, ok: 1 }));
  });

  it("keeps the most urgent state when entries disagree about one surface", () => {
    expect(tally([item("skills", "ok", "claude"), item("skills", "decide", "codex"), item("skills", "ready", "opencode")])).toEqual(
      counts({ decide: 1 }),
    );
  });

  it("counts the workspace item once and skips items without a state", () => {
    expect(tally([item("workspace_bundle", "ready", "workspace"), item("codex_rules", null)])).toEqual(counts({ ready: 1 }));
  });
});

describe("summaryParts", () => {
  it("omits zeros and follows the summary order", () => {
    const parts = summaryParts(counts({ fix: 1, ok: 3, decide: 2 }));
    expect(parts.map(part => part.state)).toEqual(["ok", "decide", "fix"]);
    expect(parts.map(part => part.count)).toEqual([3, 2, 1]);
  });

  it("pluralises by count", () => {
    expect(summaryParts(counts({ decide: 1 }))[0]!.text).toBe("1 needs your decision");
    expect(summaryParts(counts({ decide: 2 }))[0]!.text).toBe("2 need your decision");
    expect(summaryParts(counts({ ready: 1 }))[0]!.text).toBe("1 update ready");
    expect(summaryParts(counts({ ready: 2 }))[0]!.text).toBe("2 updates ready");
    expect(summaryParts(counts({ ok: 4, yours: 1, fix: 1, off: 2 })).map(part => part.text)).toEqual([
      "4 up to date",
      "1 yours",
      "1 to fix by hand",
      "2 not managed",
    ]);
  });

  it("is empty when every count is zero", () => {
    expect(summaryParts(counts())).toEqual([]);
  });
});

describe("overviewHeadline", () => {
  const ctx = { dataFolderOk: true, anyStatus: true, allNotInstalled: false };

  it("says the folder is unusable first", () => {
    expect(overviewHeadline(counts({ decide: 1 }), { ...ctx, dataFolderOk: false })).toBe("Riggverk can't use its folder.");
  });

  it("says it is checking until a status arrives", () => {
    expect(overviewHeadline(counts(), { ...ctx, anyStatus: false })).toBe("Checking your setup…");
  });

  it("says nothing is set up when everything is a fresh install", () => {
    expect(overviewHeadline(counts({ ready: 4 }), { ...ctx, allNotInstalled: true })).toBe("Nothing is set up yet.");
  });

  it("says everything is set up when nothing needs a decision, a fix or an update", () => {
    expect(overviewHeadline(counts({ ok: 5, yours: 1, off: 2 }), ctx)).toBe("Everything is set up.");
  });

  it("says the setup works when something is left to do", () => {
    expect(overviewHeadline(counts({ ok: 3, ready: 1 }), ctx)).toBe("Your setup works.");
    expect(overviewHeadline(counts({ ok: 3, decide: 1 }), ctx)).toBe("Your setup works.");
    expect(overviewHeadline(counts({ ok: 3, fix: 1 }), ctx)).toBe("Your setup works.");
  });
});

describe("runtimeSubline", () => {
  it("shows the verdict when the harness is up to date or ready and the runtime warns", () => {
    expect(runtimeSubline("ok", { text: "diverged", tone: "warn" })).toBe("Runtime check: diverged");
    expect(runtimeSubline("ready", { text: "missing", tone: "fail" })).toBe("Runtime check: missing");
  });

  it("is suppressed for decide, yours, fix and off, which already explain the drift", () => {
    for (const state of ["decide", "yours", "fix", "off"] as const) {
      expect(runtimeSubline(state, { text: "diverged", tone: "warn" })).toBeNull();
    }
    expect(runtimeSubline(null, { text: "diverged", tone: "warn" })).toBeNull();
  });

  it("is quiet for a healthy or unknown runtime", () => {
    expect(runtimeSubline("ok", { text: "synced", tone: "ok" })).toBeNull();
    expect(runtimeSubline("ok", { text: "not loaded", tone: "dim" })).toBeNull();
  });
});

describe("postureMark", () => {
  it("maps the four levels", () => {
    expect(postureMark("risky")).toEqual({ text: "Worth a look", kind: "tip" });
    expect(postureMark("enforced")).toEqual({ text: "Set", kind: "set" });
    expect(postureMark("advice")).toEqual({ text: "Tip", kind: "tip" });
    expect(postureMark("not_covered")).toBeNull();
  });
});

describe("state tables", () => {
  it("has exactly six labels, one per state", () => {
    expect(Object.keys(UI_STATE_LABEL)).toHaveLength(6);
    expect(Object.values(UI_STATE_LABEL)).toEqual(["Up to date", "Update ready", "Needs your decision", "Yours", "Fix by hand", "Not managed"]);
  });

  it("orders precedence and summary over the same six states", () => {
    expect([...UI_STATE_PRECEDENCE].sort()).toEqual(Object.keys(UI_STATE_LABEL).sort());
    expect([...UI_STATE_SUMMARY_ORDER].sort()).toEqual(Object.keys(UI_STATE_LABEL).sort());
    expect(UI_STATE_PRECEDENCE[0]).toBe("decide");
  });
});
