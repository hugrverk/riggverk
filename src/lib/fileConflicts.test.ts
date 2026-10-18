import { describe, expect, it } from "vitest";
import type { FilesStatus, FileUnit, InstallationStatus, SetupSurfaceId } from "../types";
import {
  fileConflictModelFor,
  fileGates,
  filesCountsText,
  filesPageHint,
  filesSurfacesOf,
  isFilesSurface,
  markedUnit,
  nextUnitKey,
  resolvePointer,
  unitFilesText,
  unitLine,
  withFileConflicts,
  type FileConflictModel,
} from "./fileConflicts";
import type { StateDisplay } from "./installationView";

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
    read_by: [],
    files: [{ rel: "SKILL.md", state: "conflict", reason: "edited", bundle_changed: false }],
    more_files: 0,
    ...overrides,
  };
}

function statusWith(surface: SetupSurfaceId, files: FilesStatus | undefined): InstallationStatus {
  return {
    state: "conflict",
    summary: "conflict",
    counts: { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 1 },
    surfaces: [{ surface, label: surface, state: "conflict", detail: "", ...(files ? { files } : {}) }],
  };
}

function filesOf(units: FileUnit[]): FilesStatus {
  const files = units.flatMap(candidate => candidate.files);
  return {
    conflicts: files.filter(file => file.state === "conflict").length,
    kept: files.filter(file => file.state === "kept").length,
    kept_updates: files.filter(file => file.state === "kept" && file.bundle_changed).length,
    units,
    more: 0,
  };
}

function modelOf(units: FileUnit[], surface: FileConflictModel["surface"] = "skills"): FileConflictModel {
  return fileConflictModelFor(statusWith(surface, filesOf(units)), surface)!;
}

const CONTEXT = { workspaceValid: true, busyLabel: null, blockedBy: null };

const CURRENT: StateDisplay = { glyph: "ok", tone: "ok", label: "current" };
const UPDATE: StateDisplay = { glyph: "partial", tone: "warn", label: "update" };
const CONFLICT: StateDisplay = { glyph: "fail", tone: "fail", label: "conflict" };

describe("which surfaces hold skill and agent files", () => {
  it("is the shared skills surface and the agents surface of the harness, when it has one", () => {
    expect(filesSurfacesOf("claude")).toEqual(["claude_agents", "skills"]);
    expect(filesSurfacesOf("codex")).toEqual(["codex_agents", "skills"]);
    expect(filesSurfacesOf("opencode")).toEqual(["open_code_agents", "skills"]);
    expect(filesSurfacesOf("cursor")).toEqual(["cursor_agents", "skills"]);
    expect(filesSurfacesOf("copilot")).toEqual(["skills"]);
    expect(isFilesSurface("skills")).toBe(true);
    expect(isFilesSurface("claude_rules")).toBe(false);
    expect(isFilesSurface("cursor_mcp")).toBe(false);
  });
});

describe("fileConflictModelFor", () => {
  it("is the files of the surface, or null while there are none", () => {
    expect(fileConflictModelFor(statusWith("skills", filesOf([unit()])), "skills")?.units).toHaveLength(1);
    expect(fileConflictModelFor(statusWith("skills", undefined), "skills")).toBeNull();
    expect(fileConflictModelFor(statusWith("skills", filesOf([])), "skills")).toBeNull();
    expect(fileConflictModelFor(null, "skills")).toBeNull();
    // Another surface's files are not this surface's.
    expect(fileConflictModelFor(statusWith("skills", filesOf([unit()])), "claude_agents")).toBeNull();
    expect(fileConflictModelFor(statusWith("claude_rules", filesOf([unit()])), "claude_rules")).toBeNull();
  });
});

describe("marking a unit", () => {
  const model = modelOf([unit(), unit({ key: "skill:agents:tdd", folder: "~/.agents/skills" }), unit({ key: "skill:claude:diagnose", name: "diagnose" })]);

  it("marks the first unit until one is named, and again when the marked one is gone", () => {
    expect(markedUnit(model, null)?.key).toBe("skill:claude:tdd");
    expect(markedUnit(model, "skill:claude:diagnose")?.name).toBe("diagnose");
    expect(markedUnit(model, "skill:claude:gone")?.key).toBe("skill:claude:tdd");
    expect(markedUnit(null, "x")).toBeNull();
  });

  it("moves to the next unit and wraps around", () => {
    expect(nextUnitKey(model, null)).toBe("skill:agents:tdd");
    expect(nextUnitKey(model, "skill:agents:tdd")).toBe("skill:claude:diagnose");
    expect(nextUnitKey(model, "skill:claude:diagnose")).toBe("skill:claude:tdd");
    expect(nextUnitKey(modelOf([unit()]), null)).toBe("skill:claude:tdd");
  });
});

describe("unitLine", () => {
  it("tells a skill in conflict by what, where, how many files and why", () => {
    const line = unitLine(
      unit({
        files: [
          { rel: "SKILL.md", state: "conflict", reason: "edited", bundle_changed: false },
          { rel: "HUNTING.md", state: "conflict", reason: "edited", bundle_changed: false },
        ],
        read_by: ["Claude", "OpenCode"],
      }),
    );
    expect(line.text).toBe("tdd · ~/.claude/skills · SKILL.md +1 file · edited since Riggverk wrote it · read by Claude, OpenCode");
    expect(line.tone).toBe("fail");
  });

  it("says when nothing proves the app wrote the file", () => {
    expect(unitLine(unit({ reason: "unproven" })).text).toContain("not written by Riggverk (no record)");
  });

  it("tells a kept skill and whether the bundle moved on", () => {
    const kept = unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] });
    expect(unitLine(kept)).toEqual({ text: "tdd · ~/.claude/skills · SKILL.md · you manage · bundle unchanged", tone: "dim" });
    expect(unitLine({ ...kept, bundle_changed: true })).toEqual({
      text: "tdd · ~/.claude/skills · SKILL.md · you manage · bundled update available",
      tone: "warn",
    });
  });

  it("does not wait for a bundled update that nothing bundles", () => {
    const retired = unit({ state: "kept", wanted: false });
    expect(unitLine(retired).text).toContain("you manage · no bundled copy here");
    expect(unitLine(unit({ wanted: false })).text).toContain("no longer bundled here");
  });

  it("names an agent without repeating its file, and counts files beyond the listed ones", () => {
    const agent = unit({ kind: "agent", name: "verifier", folder: "~/.claude/agents", files: [{ rel: "verifier.md", state: "conflict", reason: "edited", bundle_changed: false }], read_by: ["Claude"] });
    expect(unitLine(agent).text).toBe("verifier · ~/.claude/agents · edited since Riggverk wrote it");
    expect(unitFilesText(unit({ more_files: 4 }))).toBe("SKILL.md +4 files");
    expect(unitFilesText(unit())).toBe("SKILL.md");
  });
});

describe("withFileConflicts", () => {
  it("adds the count of files in conflict and turns a good state into a bad one", () => {
    const conflicts = modelOf([unit(), unit({ key: "skill:claude:b", name: "b" })]);
    expect(withFileConflicts(UPDATE, conflicts)).toEqual({ glyph: "fail", tone: "fail", label: "update · 2 conflicts" });
    // The backend state "conflict" is replaced by the count, not repeated.
    expect(withFileConflicts(CONFLICT, conflicts).label).toBe("2 conflicts");
    expect(withFileConflicts(CONFLICT, modelOf([unit()])).label).toBe("1 conflict");
  });

  it("tells the files the user keeps beside a state that is otherwise current, as a warning", () => {
    const kept = modelOf([unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] })]);
    expect(withFileConflicts(CURRENT, kept)).toEqual({ glyph: "partial", tone: "warn", label: "current · you manage 1" });
    // The matrix word "you manage" is replaced by the count.
    expect(withFileConflicts({ glyph: "partial", tone: "warn", label: "you manage" }, kept).label).toBe("you manage 1");
  });

  it("keeps both counts when there are conflicts and kept files", () => {
    const both = modelOf([unit(), unit({ key: "skill:claude:b", name: "b", state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] })]);
    expect(withFileConflicts(UPDATE, both).label).toBe("update · 1 conflict · you manage 1");
  });

  it("leaves a surface without files as it is", () => {
    expect(withFileConflicts(CURRENT, null)).toBe(CURRENT);
  });
});

describe("fileGates", () => {
  const conflict = unit();
  const kept = unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] });
  const two = modelOf([conflict, unit({ key: "skill:claude:b", name: "b" })]);

  it("offers diff and keep for a unit in conflict, diff and hand back for a kept one, and next only with two units", () => {
    const gates = fileGates(two, conflict, CONTEXT);
    expect(gates.diff).toEqual({ visible: true, reason: null });
    expect(gates.keep).toEqual({ visible: true, reason: null });
    expect(gates.manage.visible).toBe(false);
    expect(gates.next).toEqual({ visible: true, reason: null });

    const handBack = fileGates(modelOf([kept]), kept, CONTEXT);
    expect(handBack.manage.visible).toBe(true);
    expect(handBack.keep.visible).toBe(false);
    expect(handBack.next.visible).toBe(false);
  });

  it("gives the reason an action waits: a running task, or a review that is open", () => {
    expect(fileGates(two, conflict, { ...CONTEXT, busyLabel: "update claude" }).keep.reason).toBe("update claude is running");
    expect(fileGates(two, conflict, { ...CONTEXT, blockedBy: "close the install review first" }).diff.reason).toBe("close the install review first");
    // Marking a unit reads nothing and writes nothing: only an open review gets in its way.
    expect(fileGates(two, conflict, { ...CONTEXT, busyLabel: "update claude" }).next.reason).toBeNull();
  });

  it("offers nothing without a unit, a model or a workspace", () => {
    for (const gates of [fileGates(null, null, CONTEXT), fileGates(two, conflict, { ...CONTEXT, workspaceValid: false })]) {
      expect(Object.values(gates).every(gate => !gate.visible && gate.reason === null)).toBe(true);
    }
  });
});

describe("texts", () => {
  it("counts files in conflict and kept ones in one phrase", () => {
    expect(filesCountsText(modelOf([unit()]))).toBe("1 in conflict");
    const kept = unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] });
    expect(filesCountsText(modelOf([kept]))).toBe("you manage 1");
    expect(filesCountsText(modelOf([unit(), { ...kept, key: "skill:claude:b" }]))).toBe("1 in conflict · you manage 1");
  });

  it("points the workspace page at the harness page and the keys there", () => {
    expect(filesPageHint(modelOf([unit()]), "claude")).toBe("open the claude page: d diff · m keep mine");
    const kept = unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] });
    expect(filesPageHint(modelOf([kept]), "claude")).toBe("open the claude page: d diff · m hand back");
  });

  it("points the install review at the page where a file in conflict is resolved", () => {
    expect(resolvePointer("skills")).toBe("resolve from a harness page: d diff · m keep mine");
    expect(resolvePointer("claude_agents")).toBe("resolve from the Claude page: d diff · m keep mine");
    expect(resolvePointer("open_code_agents")).toBe("resolve from the OpenCode page: d diff · m keep mine");
    expect(resolvePointer("claude_rules")).toBeNull();
    expect(resolvePointer("workspace_bundle")).toBeNull();
  });
});
