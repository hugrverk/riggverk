import { describe, expect, it } from "vitest";
import type { SetupResult, TakeBundledPreview, TakeBundledUnit } from "../types";
import { formatTakeBundledOutput, takeBundledTitle } from "./useFileConflictFlow";

function unit(overrides: Partial<TakeBundledUnit> = {}): TakeBundledUnit {
  return {
    key: "skill:claude:tdd",
    name: "tdd",
    folder: "~/.claude/skills",
    files: [
      {
        rel: "SKILL.md",
        state: "conflict",
        backup_name: "artifacts/skill-claude-tdd~SKILL.md",
        installed_digest: "sha256:0123456789ab",
        bundled_digest: "sha256:ba9876543210",
      },
    ],
    more_files: 0,
    diff: { name: "tdd", folder: "~/.claude/skills", files: [], more_files: 0, truncated: false },
    ...overrides,
  };
}

function preview(units: TakeBundledUnit[] = [unit()]): TakeBundledPreview {
  return { surface: "skills", units, plan_fingerprint: "abcdef0123456789abcdef", preview_token: "tok-1" };
}

function result(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    success: true,
    transaction_id: "tx-1",
    applied: ["claude/tdd/SKILL.md"],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: "Successfully applied 1 artifact(s)",
    ...overrides,
  };
}

describe("takeBundledTitle", () => {
  it("names the unit, with its file count only when more than one file is replaced", () => {
    expect(takeBundledTitle(unit())).toBe("tdd");
    expect(takeBundledTitle(unit({ files: [unit().files[0]!, unit().files[0]!], more_files: 1 }))).toBe("tdd (3 files)");
  });
});

describe("formatTakeBundledOutput", () => {
  it("tells what was replaced, that yours is backed up, and that the transaction can be rolled back", () => {
    const { stdout, stderr } = formatTakeBundledOutput(preview(), result());
    expect(stdout.split("\n")).toEqual([
      "plan abcdef01 · take bundled tdd · fingerprint verified",
      "applied      tdd · yours backed up",
      "Successfully applied 1 artifact(s)",
      "applied 1 · failed 0 · rolled back 0",
      "transaction tx-1 recorded · rollback available",
    ]);
    expect(stderr).toBe("");
  });

  it("names a failure and a rollback without claiming a backup, and carries the manual steps", () => {
    const failed = formatTakeBundledOutput(
      preview(),
      result({
        success: false,
        applied: [],
        failed: ["tdd: file changed since preview; preview again"],
        rolled_back: ["claude/tdd/SKILL.md"],
        manual_steps: ["a note"],
        message: "Artifact mutation failed",
      }),
    );
    expect(failed.stdout).toContain("rolled back  tdd");
    expect(failed.stdout).not.toContain("yours backed up");
    expect(failed.stdout).toContain("manual       a note");
    expect(failed.stdout.endsWith("transaction tx-1 recorded")).toBe(true);
    expect(failed.stderr).toBe("tdd: file changed since preview; preview again");
  });

  it("counts the files of a skill in the line", () => {
    const many = unit({ files: [unit().files[0]!, { ...unit().files[0]!, rel: "HUNTING.md" }] });
    expect(formatTakeBundledOutput(preview([many]), result()).stdout).toContain("applied      tdd (2 files) · yours backed up");
  });
});
