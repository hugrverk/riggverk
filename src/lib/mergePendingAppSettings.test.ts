import { describe, expect, it } from "vitest";
import { mergePendingLocalOntoAcknowledged } from "./mergePendingAppSettings";
import { serializeSettingsForCompare } from "./settingsDraft";
import type { AppSettings } from "../types";

const base: AppSettings = {
  appearance: "dark",
  app_font_size: "medium",
  workspace_path: null,
  enabled_target_ids: ["codex_rules"],
  enabled_harness_ids: ["codex", "opencode", "claude", "cursor"],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  motion: "full",
  landing_view: "start",
  revision: 2,
};

describe("mergePendingAppSettings", () => {
  it("overlays pending theme fields onto acknowledged settings", () => {
    const local = { ...base, appearance: "light" as const, app_font_size: "large" as const };
    const savedSerialized = serializeSettingsForCompare(base);
    const merged = mergePendingLocalOntoAcknowledged(
      { ...base, revision: 5 },
      local,
      savedSerialized,
    );
    expect(merged.appearance).toBe("light");
    expect(merged.app_font_size).toBe("large");
    expect(merged.revision).toBe(5);
  });

  it("keeps pending motion and landing_view edits", () => {
    const savedSerialized = serializeSettingsForCompare(base);
    const local: AppSettings = { ...base, motion: "subtle", landing_view: "library" };
    const rebased = mergePendingLocalOntoAcknowledged({ ...base, revision: 6 }, local, savedSerialized);
    expect(rebased.motion).toBe("subtle");
    expect(rebased.landing_view).toBe("library");
    expect(rebased.revision).toBe(6);
  });

  it("returns the acknowledged settings when nothing is pending", () => {
    const savedSerialized = serializeSettingsForCompare(base);
    const acknowledged = { ...base, revision: 9, landing_view: "library" };
    expect(mergePendingLocalOntoAcknowledged(acknowledged, base, savedSerialized)).toBe(acknowledged);
  });
});
