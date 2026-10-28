import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupHistoryEntry } from "../types";
import { HistoryView, type HistoryViewProps } from "./HistoryView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function entry(id: string, overrides: Partial<SetupHistoryEntry> = {}): SetupHistoryEntry {
  return {
    transaction_id: id,
    created_at: `${id}000000000`,
    finished_at: null,
    status: "applied",
    surfaces: ["codex_rules"],
    harnesses: ["codex"],
    changes: [{ surface: "codex_rules", kind: "update", path: "~/.codex/AGENTS.md", applied: true, restored: false }],
    operation_counts: { create: 0, update: 1, remove: 0 },
    backup_files: 1,
    is_newest_completed: false,
    undoable: false,
    receipt: null,
    ...overrides,
  };
}

const NEWEST = entry("1792663200", {
  is_newest_completed: true,
  undoable: true,
  receipt: { synced: ["claude_rules"], left_for_you: [{ surface: "cursor_agents", reason: "conflict" }] },
});
const UNDONE = entry("1792576800", {
  status: "rolled_back",
  harnesses: ["opencode"],
  surfaces: ["open_code_config"],
  changes: [{ surface: "open_code_config", kind: "update", path: "~/.config/opencode/opencode.json", applied: true, restored: true }],
});
const OLD = entry("1792490400", { harnesses: ["claude"], surfaces: ["claude_rules"] });

let history: SetupHistoryEntry[] = [];

beforeEach(() => {
  history = [NEWEST, UNDONE, OLD];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "list_setup_history") return history;
    throw new Error(`unexpected invoke ${command}`);
  });
});

afterEach(cleanup);

function renderHistory(overrides: Partial<HistoryViewProps> = {}) {
  const props: HistoryViewProps = { dataFolderOk: true, backupCount: 4, wsRunning: null, wsLogCompletedAt: null, onUndo: vi.fn(), ...overrides };
  return { props, ...render(<HistoryView {...props} />) };
}

const runs = async () => within(await screen.findByRole("list", { name: "Updates, newest first" })).getAllByRole("listitem");
const header = (run: HTMLElement) => run.querySelector<HTMLElement>("button[aria-expanded]")!;

describe("HistoryView", () => {
  it("lists the runs newest first with the outcome in words, the newest one open", async () => {
    renderHistory();
    const items = await runs();
    expect(items.map(item => item.querySelector("b")!.textContent)).toEqual(["Updated Codex", "Updated OpenCode", "Updated Claude"]);
    expect(items.map(item => item.querySelector(".state-pill")!.textContent)).toEqual(["Done", "Undone", "Done"]);
    expect(items.map(item => header(item).getAttribute("aria-expanded"))).toEqual(["true", "false", "false"]);
    expect(screen.getByText("Every update, newest first")).toBeTruthy();
  });

  it("opens a run to its receipt and closes it again", async () => {
    renderHistory();
    const items = await runs();
    const button = header(items[2]!);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(within(items[2]!).getByText("Changed").nextElementSibling!.textContent).toBe("codex rules · 1 file");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // The newest starts open and can be closed.
    fireEvent.click(header(items[0]!));
    expect(header(items[0]!).getAttribute("aria-expanded")).toBe("false");
  });

  it("states only what the run recorded: Checked and Left for you appear only with a receipt", async () => {
    renderHistory();
    const items = await runs();
    const newest = within(items[0]!);
    expect(newest.getByText("Checked").nextElementSibling!.textContent).toBe("claude rules · current");
    expect(newest.getByText("Left for you").nextElementSibling!.textContent).toBe("cursor agents · you edited it");
    expect(newest.getByText("Backup").nextElementSibling!.textContent).toBe("1 file · kept with 4 backups");
    expect(within(items[2]!).queryByText("Checked")).toBeNull();
    expect(within(items[2]!).queryByText("Left for you")).toBeNull();
  });

  it("names a rolled-back run's files as restored, not changed", async () => {
    renderHistory({});
    const items = await runs();
    expect(within(items[1]!).getByText("Restored").nextElementSibling!.textContent).toBe("1 file from the backup");
    expect(within(items[1]!).queryByText("Changed")).toBeNull();
  });

  it("offers Undo on the newest completed run only and starts the undo of exactly that run", async () => {
    const { props } = renderHistory();
    await runs();
    const buttons = screen.getAllByRole("button", { name: "Undo this update…" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(props.onUndo).toHaveBeenCalledWith(NEWEST.transaction_id);
    expect(props.onUndo).toHaveBeenCalledTimes(1);
  });

  it("offers no Undo when the backend offers none, or on a run that is not the newest completed one", async () => {
    history = [
      { ...NEWEST, undoable: false },
      // Flagged undoable but not the newest completed: the page does not trust the flag alone.
      { ...OLD, undoable: true, is_newest_completed: false },
    ];
    renderHistory();
    await runs();
    expect(screen.queryByRole("button", { name: "Undo this update…" })).toBeNull();
  });

  it("keeps Undo from starting while a task runs, and says why", async () => {
    const { props } = renderHistory({ wsRunning: "update codex" });
    await runs();
    const undo = screen.getByRole("button", { name: "Undo this update…" });
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.getAttribute("title")).toBe("update codex is running");
    fireEvent.click(undo);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it("reads again when a task finishes", async () => {
    const { rerender, props } = renderHistory();
    await runs();
    history = [entry("1792700000", { is_newest_completed: true, undoable: true, harnesses: ["cursor"], surfaces: ["cursor_agents"] }), ...history];
    rerender(<HistoryView {...props} wsLogCompletedAt={Date.now()} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    expect(screen.getAllByRole("button", { name: "Undo this update…" })).toHaveLength(1);
  });

  it("says so when nothing has been updated yet", async () => {
    history = [];
    renderHistory();
    expect(await screen.findByText(/Nothing has been updated yet/)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says when the history cannot be read, instead of showing an empty list", async () => {
    invokeMock.mockRejectedValue(new Error("no history"));
    renderHistory();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't read the history/);
  });

  it("does not read anything without a usable workspace folder", () => {
    renderHistory({ dataFolderOk: false });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/can't use right now/)).toBeTruthy();
  });

  it("is the page pane, so the app's keys work with focus on it", async () => {
    renderHistory();
    await runs();
    const page = screen.getByRole("region", { name: "History" });
    expect(page.getAttribute("data-pane-id")).toBe("page");
    expect(page.hasAttribute("data-pane-default")).toBe(true);
  });
});
