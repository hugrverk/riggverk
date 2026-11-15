import { describe, expect, it } from "vitest";
import type { FilesStatus, FileUnit, InstallationStatus, SetupSurfaceId } from "../types";
import {
  fileConflictModelFor,
  fileGates,
  filesSurfacesOf,
  isFilesSurface,
  markedUnit,
  nextUnitKey,
  NO_BUNDLED_COPY,
  resolvePointer,
  unitDetail,
  filesWhy,
  type FileConflictModel,
} from "./fileConflicts";

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

const CONTEXT = { dataFolderOk: true, busyLabel: null, blockedBy: null };

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

  it("offers take bundled for a unit in conflict and a kept one alike", () => {
    expect(fileGates(two, conflict, CONTEXT).bundled).toEqual({ visible: true, reason: null });
    expect(fileGates(modelOf([kept]), kept, CONTEXT).bundled).toEqual({ visible: true, reason: null });
  });

  it("offers take bundled disabled with a reason for a unit the bundle no longer ships in its folder", () => {
    const retired = unit({ wanted: false });
    expect(fileGates(modelOf([retired]), retired, CONTEXT).bundled).toEqual({ visible: true, reason: NO_BUNDLED_COPY });
    // Keeping and the diff are still there: only the replacement has nothing to take.
    expect(fileGates(modelOf([retired]), retired, CONTEXT).keep).toEqual({ visible: true, reason: null });
    // The permanent reason wins over a passing one.
    expect(fileGates(modelOf([retired]), retired, { ...CONTEXT, busyLabel: "update claude" }).bundled.reason).toBe(NO_BUNDLED_COPY);
  });

  it("gives the reason an action waits: a running task, or a review that is open", () => {
    expect(fileGates(two, conflict, { ...CONTEXT, busyLabel: "update claude" }).keep.reason).toBe("update claude is running");
    expect(fileGates(two, conflict, { ...CONTEXT, busyLabel: "update claude" }).bundled.reason).toBe("update claude is running");
    expect(fileGates(two, conflict, { ...CONTEXT, blockedBy: "close the conflict review first" }).bundled.reason).toBe("close the conflict review first");
    expect(fileGates(two, conflict, { ...CONTEXT, blockedBy: "close the install review first" }).diff.reason).toBe("close the install review first");
    // Marking a unit reads nothing and writes nothing: only an open review gets in its way.
    expect(fileGates(two, conflict, { ...CONTEXT, busyLabel: "update claude" }).next.reason).toBeNull();
  });

  it("offers nothing without a unit, a model or a workspace", () => {
    for (const gates of [fileGates(null, null, CONTEXT), fileGates(two, conflict, { ...CONTEXT, dataFolderOk: false })]) {
      expect(Object.values(gates).every(gate => !gate.visible && gate.reason === null)).toBe(true);
    }
  });
});

describe("texts", () => {
  it("points the install review at the page where a file in conflict is resolved", () => {
    expect(resolvePointer("skills")).toBe("resolve from a harness page: d diff · b take bundled · m keep mine");
    expect(resolvePointer("claude_agents")).toBe("resolve from the Claude page: d diff · b take bundled · m keep mine");
    expect(resolvePointer("open_code_agents")).toBe("resolve from the OpenCode page: d diff · b take bundled · m keep mine");
    expect(resolvePointer("claude_rules")).toBeNull();
    expect(resolvePointer("workspace_bundle")).toBeNull();
  });
});

describe("unitDetail and filesWhy", () => {
  it("leaves the name out of the detail, which is the line without it", () => {
    expect(unitDetail(unit())).toBe("~/.claude/skills · SKILL.md · edited since Riggverk wrote it");
  });

  it("says what Riggverk left alone, counted by unit, and what the user manages", () => {
    expect(filesWhy(modelOf([unit()]))).toBe("Riggverk left the 1 skill you edited exactly as it is. The rest of the update is not held up.");
    expect(filesWhy(modelOf([unit(), unit({ key: "skill:claude:b", name: "b" })]))).toBe(
      "Riggverk left the 2 skills you edited exactly as they are. The rest of the update is not held up.",
    );
    const kept = unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] });
    expect(filesWhy(modelOf([kept]))).toBe("You manage 1 skill, so Riggverk never writes it. Bundled updates stay visible.");
    expect(filesWhy({ ...modelOf([unit({ kind: "agent", name: "verifier" })]), surface: "claude_agents" })).toContain("1 agent you edited");
  });
});
