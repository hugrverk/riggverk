import { describe, expect, it } from "vitest";
import {
  applyMutationPreservingPendingLocal,
  mergePendingLocalOntoAcknowledged,
} from "./mergePendingAppSettings";
import { serializeSettingsForCompare } from "./settingsDraft";
import type { AppSettings } from "../types";

const base: AppSettings = {
  appearance: "dark",
  app_font_size: "medium",
  workspace_path: null,
  enabled_target_ids: ["codex_rules"],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  repo_dashboard_entries: [],
  active_repo_dashboard_id: null,
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

  it("preserves newer local edits after a repository mutation completes", () => {
    const savedSerialized = serializeSettingsForCompare(base);
    const sent = serializeSettingsForCompare({
      ...base,
      repo_dashboard_entries: [{ id: "r1", label: "R", path: "/tmp/r" }],
    });
    const saved = {
      ...base,
      revision: 3,
      repo_dashboard_entries: [{ id: "r1", label: "R", path: "/tmp/r" }],
      active_repo_dashboard_id: "r1",
    };
    const local = { ...saved, appearance: "light" as const };
    const merged = applyMutationPreservingPendingLocal(saved, sent, local, savedSerialized);
    expect(merged.appearance).toBe("light");
    expect(merged.active_repo_dashboard_id).toBe("r1");
  });

  it("does not roll back fields changed by the mutator itself", () => {
    const savedSerialized = serializeSettingsForCompare(base);
    const sent = serializeSettingsForCompare({ ...base, appearance: "light" });
    const saved = { ...base, revision: 3, appearance: "light" as const };
    const local = { ...base, appearance: "dark" as const };
    const merged = applyMutationPreservingPendingLocal(saved, sent, local, savedSerialized);
    expect(merged.appearance).toBe("light");
  });
});
