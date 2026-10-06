import { describe, expect, it } from "vitest";
import { installationStatus, surfaceStatus } from "../test/pageFixtures";
import type { InstallationState, RulesStatus } from "../types";
import { refinementText, rulesModel, rulesModelFor, rulesStatusOf, rulesSurfaceOf } from "./rulesView";

function rules(overrides: Partial<RulesStatus> = {}): RulesStatus {
  return { layout: "block", refinement_lines: 0, user_managed: false, ...overrides };
}

function model(state: InstallationState, overrides: Partial<RulesStatus> = {}) {
  return rulesModel("claude_rules", state, rules(overrides));
}

describe("refinementText", () => {
  it("counts lines with the right plural", () => {
    expect(refinementText(14)).toBe("14 refinement lines preserved");
    expect(refinementText(1)).toBe("1 refinement line preserved");
    expect(refinementText(0)).toBe("none");
  });
});

describe("rulesModel", () => {
  it("reports a current block with its layout and refinements", () => {
    const m = model("current", { refinement_lines: 3 });
    expect(m).toMatchObject({ kind: "current", layout: "managed base block", refinements: "3 refinement lines preserved", tone: "ok", reason: null });
    expect(m.display).toBeNull();
    expect(m.convertible).toBe(false);
  });

  it("calls a base update that keeps user text an update, never a conflict", () => {
    const m = model("update_available", { refinement_lines: 14 });
    expect(m).toMatchObject({ kind: "update", headline: "base update available", refinements: "14 refinement lines preserved", diffMode: "update", convertible: false });
  });

  it("explains an untouched plain file moving into the block", () => {
    expect(model("update_available", { layout: "legacy" })).toMatchObject({ kind: "update", headline: "unmodified file moves into the base block" });
  });

  it("explains an edited base block and offers conversion with the edits diff", () => {
    const m = model("conflict", { conflict_reason: "base_block_edited", refinement_lines: 2 });
    expect(m).toMatchObject({ kind: "conflict", tone: "fail", reason: "the base block was edited", convertible: true, diffMode: "edits", diffDisabled: false });
    expect(m.headline).toContain("base block edited");
  });

  it("explains a plain file that differs from every shipped base", () => {
    const m = model("conflict", { layout: "legacy", conflict_reason: "legacy_diverged" });
    expect(m).toMatchObject({ kind: "conflict", reason: "the file differs from every shipped base", convertible: true, diffMode: "edits" });
  });

  it("names the malformed-marker rule and offers neither conversion nor a diff", () => {
    const m = model("conflict", { layout: "malformed", conflict_reason: "malformed_markers", malformed_reason: "missing_end" });
    expect(m).toMatchObject({ kind: "malformed", tone: "fail", convertible: false });
    expect(m.reason).toBe("the base block markers are malformed: BEGIN marker has no matching END marker");
    expect(m.diffDisabled).toContain("malformed");
  });

  it("shows a user-managed file as base updates available instead of a red conflict or green current", () => {
    // The planner leaves such a file alone, so the surface state is `current`.
    const m = model("current", { conflict_reason: "base_block_edited", user_managed: true });
    expect(m).toMatchObject({ kind: "managed", tone: "warn", headline: "base updates available, you manage this file", convertible: true, user_managed: true });
    expect(m.display).toEqual({ glyph: "partial", tone: "warn", label: "you manage" });
    expect(m.reason).toBe("the base block was edited");
  });

  it("has no diff for a missing file", () => {
    const m = model("not_installed", { layout: "absent" });
    expect(m).toMatchObject({ kind: "absent", diffDisabled: "no rules file is installed" });
  });
});

describe("rules surfaces", () => {
  it("maps harnesses to their rules surface; Cursor has none", () => {
    expect(rulesSurfaceOf("codex")).toBe("codex_rules");
    expect(rulesSurfaceOf("opencode")).toBe("open_code_rules");
    expect(rulesSurfaceOf("claude")).toBe("claude_rules");
    expect(rulesSurfaceOf("cursor")).toBeNull();
  });

  it("reads the block details from the installation status", () => {
    const status = installationStatus("conflict", [
      { ...surfaceStatus("claude_rules", "conflict"), rules: rules({ conflict_reason: "base_block_edited" }) },
      surfaceStatus("claude_agents", "current"),
    ]);
    expect(rulesStatusOf(status, "claude_rules")?.conflict_reason).toBe("base_block_edited");
    expect(rulesModelFor("claude", status)?.kind).toBe("conflict");
    expect(rulesModelFor("cursor", status)).toBeNull();
    expect(rulesModelFor("codex", status)).toBeNull();
    expect(rulesModelFor("claude", null)).toBeNull();
  });
});
