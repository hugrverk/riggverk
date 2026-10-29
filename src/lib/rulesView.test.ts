import { describe, expect, it } from "vitest";
import { installationStatus, surfaceStatus } from "../test/pageFixtures";
import type { InstallationState, RulesStatus } from "../types";
import {
  refinementText,
  rulesFileName,
  rulesGates,
  RULES_HARNESSES,
  rulesModel,
  rulesModelFor,
  rulesSurfaceOf,
  rulesWhy,
} from "./rulesView";

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
    expect(m.display).toEqual({ tone: "warn", label: "you manage" });
    expect(m.reason).toBe("the base block was edited");
  });

  it("calls a file that another file masks blocked: no conversion, no leave-as-is, the diff only when there is a file", () => {
    const m = rulesModel("pi_rules", "conflict", rules({ conflict_reason: "masked_by_override" }));
    expect(m).toMatchObject({
      kind: "blocked",
      tone: "fail",
      convertible: false,
      headline: "masked by another file: left as is",
      reason: "another file in the folder masks this one, so the harness never reads it",
      diffDisabled: false,
    });
    const gates = rulesGates(m, { dataFolderOk: true, busyLabel: null, blockedBy: null });
    expect(gates.diff.visible).toBe(true);
    expect([gates.convert.visible, gates.leave.visible, gates.manage.visible]).toEqual([false, false, false]);
  });

  it("calls a missing file that a peer would be hidden by blocked, not not installed", () => {
    const m = rulesModel("pi_rules", "conflict", rules({ layout: "absent", conflict_reason: "peer_context_file" }));
    expect(m).toMatchObject({
      kind: "blocked",
      headline: "another context file would be hidden: nothing written",
      reason: "the harness reads another context file in the folder, which a new file would hide",
      diffDisabled: "no rules file is installed",
      convertible: false,
    });
    expect(rulesGates(m, { dataFolderOk: true, busyLabel: null, blockedBy: null }).diff.visible).toBe(true);
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
    expect(rulesSurfaceOf("copilot")).toBe("copilot_rules");
    expect(rulesSurfaceOf("pi")).toBe("pi_rules");
    expect(rulesSurfaceOf("kilo")).toBe("kilo_rules");
    expect(rulesSurfaceOf("cursor")).toBeNull();
  });

  it("offers the rules command for every harness that has a rules surface", () => {
    expect([...RULES_HARNESSES]).toEqual(["codex", "opencode", "claude", "copilot", "pi", "kilo"]);
    for (const harness of RULES_HARNESSES) expect(rulesSurfaceOf(harness)).not.toBeNull();
  });

  it("names the file each harness's rules surface writes", () => {
    expect(rulesFileName("claude")).toBe("CLAUDE.md");
    expect(rulesFileName("copilot")).toBe("copilot-instructions.md");
    for (const harness of ["codex", "opencode", "pi", "kilo"] as const) expect(rulesFileName(harness)).toBe("AGENTS.md");
  });

  it("reads the block details from the installation status", () => {
    const status = installationStatus("conflict", [
      { ...surfaceStatus("claude_rules", "conflict"), rules: rules({ conflict_reason: "base_block_edited" }) },
      surfaceStatus("claude_agents", "current"),
    ]);
    expect(rulesModelFor("claude", status)?.kind).toBe("conflict");
    expect(rulesModelFor("cursor", status)).toBeNull();
    expect(rulesModelFor("codex", status)).toBeNull();
    expect(rulesModelFor("claude", null)).toBeNull();
  });
});

describe("rulesWhy", () => {
  const why = (state: InstallationState, overrides: Partial<RulesStatus>) => rulesWhy(model(state, overrides), "Claude", "CLAUDE.md");

  it("says what happened to an edited block and a file that matches no shipped version, and what the harness reads", () => {
    expect(why("conflict", { conflict_reason: "base_block_edited" })).toBe(
      "Riggverk left CLAUDE.md exactly as it is, because its managed block was edited. Claude reads your version and doesn't have the newest Riggverk rules yet.",
    );
    expect(why("conflict", { layout: "legacy", conflict_reason: "legacy_diverged" })).toContain("it matches none of the versions Riggverk ships");
  });

  it("says a managed file is the user's, and a base update can be taken", () => {
    expect(why("current", { conflict_reason: "base_block_edited", user_managed: true })).toContain("You manage CLAUDE.md, so Riggverk never writes it.");
    expect(why("update_available", {})).toContain("CLAUDE.md can take the newest Riggverk rules.");
  });

  it("tells a fix by hand for markers and another file in the way", () => {
    expect(why("conflict", { layout: "malformed", conflict_reason: "malformed_markers", malformed_reason: "duplicate_begin" })).toContain("Fix the markers by hand");
    expect(why("conflict", { conflict_reason: "masked_by_override" })).toContain("Another file in the folder decides what Claude reads");
  });

  it("has nothing to add for a current file or a missing one: the state pill says it", () => {
    expect(why("current", {})).toBeNull();
    expect(why("not_installed", { layout: "absent" })).toBeNull();
  });

  it("keeps the model's conflict code for the wording", () => {
    expect(model("conflict", { conflict_reason: "legacy_diverged", layout: "legacy" }).conflictReason).toBe("legacy_diverged");
    expect(model("current", {}).conflictReason).toBeNull();
  });
});
