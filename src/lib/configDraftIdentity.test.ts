import { describe, expect, it } from "vitest";

function shouldApplyOpenCodeSourceDraft(
  activeTargetId: string,
  activeSourceType: string,
  draftIdentity: string | null,
  loadSeq: number,
  responseSeq: number,
  responseSourceType: string,
): boolean {
  if (loadSeq !== responseSeq) return false;
  if (activeTargetId !== "opencode_config") return false;
  if (activeSourceType !== responseSourceType) return false;
  return draftIdentity === `opencode_config:${responseSourceType}` || draftIdentity === null;
}

describe("OpenCode config draft identity", () => {
  it("rejects a late legacy template response after source switch", () => {
    const activeSource = "policy";
    const identity = `opencode_config:${activeSource}`;
    expect(
      shouldApplyOpenCodeSourceDraft("opencode_config", activeSource, identity, 2, 1, "base"),
    ).toBe(false);
  });

  it("accepts the matching source response", () => {
    const activeSource = "base";
    const identity = `opencode_config:${activeSource}`;
    expect(
      shouldApplyOpenCodeSourceDraft("opencode_config", activeSource, identity, 3, 3, "base"),
    ).toBe(true);
  });
});
