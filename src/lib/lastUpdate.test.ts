import { describe, expect, it } from "vitest";
import type { SetupHistoryEntry } from "../types";
import { lastUpdateEntry, nanosToMillis, receiptLines, updateAgentsText, updateTimeText } from "./lastUpdate";

function entry(overrides: Partial<SetupHistoryEntry> = {}): SetupHistoryEntry {
  return {
    transaction_id: "1792663200000000000",
    created_at: "1792663200000000000",
    finished_at: "1792663202000000000",
    status: "applied",
    surfaces: ["claude_rules", "skills"],
    harnesses: ["claude"],
    changes: [
      { surface: "claude_rules", kind: "update", path: "~/.claude/CLAUDE.md", applied: true, restored: false },
      { surface: "skills", kind: "create", path: "~/.claude/skills/diagnose/SKILL.md", applied: true, restored: false },
    ],
    operation_counts: { create: 1, update: 1, remove: 0 },
    backup_files: 1,
    is_newest_completed: true,
    undoable: true,
    receipt: { synced: ["codex_rules"], left_for_you: [{ surface: "cursor_agents", reason: "conflict" }] },
    ...overrides,
  };
}

describe("nanosToMillis and updateTimeText", () => {
  it("floors unix nanoseconds to milliseconds without going through a float of the full value", () => {
    expect(nanosToMillis("1792663200123456789")).toBe(1792663200123);
    expect(nanosToMillis("999")).toBe(0);
    expect(nanosToMillis(null)).toBeNull();
    expect(nanosToMillis("12x")).toBeNull();
  });

  it("shows the time for today and the date with it for another day, from the finish time first", () => {
    const finished = new Date(1792663202000);
    expect(updateTimeText(entry(), finished)).toBe(finished.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }));
    const later = new Date(finished.getTime() + 3 * 24 * 3600 * 1000);
    expect(updateTimeText(entry(), later)).toMatch(/^\w{3} \d{1,2}, \d{2}:\d{2}$|^\d{1,2} \w{3}, \d{2}:\d{2}$/);
    expect(updateTimeText(entry({ finished_at: null, created_at: "bad" }))).toBeNull();
  });
});

describe("receiptLines", () => {
  it("states what was changed, checked, left for the user and backed up, and only that", () => {
    expect(receiptLines(entry(), 19)).toEqual([
      { label: "Changed", value: "claude rules, skills · 2 files" },
      { label: "Checked", value: "codex rules · current" },
      { label: "Left for you", value: "cursor agents · you edited it" },
      { label: "Backup", value: "1 file · kept with 19 backups" },
    ]);
  });

  it("leaves out Checked and Left for you for a run that recorded no receipt, and Backup when nothing was backed up", () => {
    const lines = receiptLines(entry({ receipt: null, backup_files: 0 }));
    expect(lines.map(line => line.label)).toEqual(["Changed"]);
  });

  it("names what a rollback restored instead of calling it changed", () => {
    const undone = entry({
      status: "rolled_back",
      changes: [{ surface: "claude_rules", kind: "update", path: "~/.claude/CLAUDE.md", applied: true, restored: true }],
    });
    expect(receiptLines(undone).slice(0, 1)).toEqual([{ label: "Restored", value: "1 file from the backup" }]);
  });

  it("tells a manual step apart from a conflict", () => {
    const lines = receiptLines(entry({ receipt: { synced: [], left_for_you: [{ surface: "cursor_mcp", reason: "manual" }] } }));
    expect(lines.find(line => line.label === "Left for you")!.value).toBe("cursor mcp · needs a manual step");
  });
});

describe("update helpers", () => {
  it("writes the agents of an update, or nothing when only shared files changed", () => {
    expect(updateAgentsText({ harnesses: ["claude", "codex"] })).toBe("Claude and Codex");
    expect(updateAgentsText({ harnesses: [] })).toBeNull();
  });

  it("takes the newest entry that is not a failed run", () => {
    const failed = entry({ transaction_id: "3", status: "failed" });
    const undone = entry({ transaction_id: "2", status: "rolled_back", undoable: false });
    expect(lastUpdateEntry([failed, undone, entry()])?.transaction_id).toBe("2");
    expect(lastUpdateEntry([failed])).toBeNull();
    expect(lastUpdateEntry([])).toBeNull();
  });
});
