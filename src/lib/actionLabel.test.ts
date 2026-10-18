import { describe, expect, it } from "vitest";
import { actionLabel } from "./actionLabel";

describe("actionLabel", () => {
  it("names a finished task the way the strip named it while it ran", () => {
    expect(actionLabel("apply_setup update claude")).toBe("update claude");
    expect(actionLabel("apply_setup install workspace")).toBe("install workspace");
    expect(actionLabel("apply_rules_conversion claude rules")).toBe("convert claude rules");
    expect(actionLabel("apply_uninstall")).toBe("uninstall");
    expect(actionLabel("rollback_setup_transaction")).toBe("rollback");
  });

  it("keeps an unknown id readable", () => {
    expect(actionLabel("open_folder")).toBe("open-folder");
    expect(actionLabel("apply_setup")).toBe("apply-setup");
  });
});
