import { describe, expect, it } from "vitest";
import { HARNESS_SURFACES, surfacesNeedingApply } from "./harnessInstallation";
import type { SetupPlan } from "../types";

describe("harnessInstallation", () => {
  it("maps each harness to setup surfaces", () => {
    expect(HARNESS_SURFACES.codex).toContain("codex_skills");
    expect(HARNESS_SURFACES.opencode).toContain("open_code_rules");
    expect(HARNESS_SURFACES.claude).toContain("claude_agents");
    expect(HARNESS_SURFACES.cursor).toContain("cursor_mcp");
  });

  it("includes remove surfaces when planning updates", () => {
    const plan: SetupPlan = {
      operations: [
        { surface: "codex_skills", kind: "remove", summary: "stale" },
        { surface: "codex_rules", kind: "no_change", summary: "synced" },
      ],
      manual_steps: [],
      is_blocked: false,
      conflicts: [],
    };
    expect(surfacesNeedingApply(plan)).toEqual(["codex_skills"]);
  });
});
