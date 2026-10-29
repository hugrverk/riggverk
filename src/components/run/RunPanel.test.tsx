import { useState } from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithShell } from "../../test/renderWithShell";
import type { ActionResult, ApplyProgress } from "../../types";
import { RunPanel, type RunPanelProps } from "./RunPanel";

const OK: ActionResult = { success: true, action: "apply_setup update claude", stdout: "applied 2 files", stderr: "", exit_code: 0 };
const FAILED: ActionResult = { success: false, action: "apply_setup update claude", stdout: "", stderr: "write failed", exit_code: 1 };

function renderPanel(props: Partial<RunPanelProps> = {}) {
  const merged: RunPanelProps = { wsRunning: null, wsLog: null, wsLogCompletedAt: null, ...props };
  return { merged, ...renderWithShell(<RunPanel {...merged} />) };
}

const panel = () => screen.getByRole("region", { name: "Run" });

afterEach(cleanup);

describe("RunPanel", () => {
  it("renders nothing before the first run", () => {
    renderPanel();
    expect(screen.queryByRole("region", { name: "Run" })).toBeNull();
  });

  it("shows the task, a hairline progress bar with the count and the file while it runs", () => {
    const progress: ApplyProgress = { task: "apply_setup", phase: "apply", done: 3, total: 8, file: "~/.codex/AGENTS.md" };
    renderPanel({ wsRunning: "update codex", progress });
    expect(within(panel()).getByRole("status").textContent).toContain("update codex");
    const bar = within(panel()).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("8");
    expect(within(panel()).getByText("3/8")).toBeTruthy();
    expect(within(panel()).getByText("~/.codex/AGENTS.md")).toBeTruthy();
    // Nothing to act on while it runs.
    expect(within(panel()).queryByRole("button")).toBeNull();
  });

  it("says backing up or working while the backend has no count to report", () => {
    renderPanel({ wsRunning: "update codex", progress: { task: "apply_setup", phase: "backup", done: 0, total: 5, file: null } });
    expect(within(panel()).getByText("backing up…")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("states the outcome in words and keeps the log closed for a result that worked", () => {
    renderPanel({ wsLog: OK, wsLogCompletedAt: new Date(2026, 9, 28, 15, 39).getTime() });
    expect(within(panel()).getByText("Done")).toBeTruthy();
    expect(within(panel()).getByText("15:39")).toBeTruthy();
    const details = within(panel()).getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(within(panel()).queryByRole("group", { name: "Output log" })).toBeNull();
  });

  it("opens the log by itself for a failed result, so the reason is in view", () => {
    renderPanel({ wsLog: FAILED, wsLogCompletedAt: Date.now() });
    expect(within(panel()).getByText("Failed")).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(panel()).getByRole("group", { name: "Output log" }).textContent).toContain("write failed");
  });

  it("opens and closes the details with the button and with Escape, and copies the redacted text", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const secret = `token=${"a".repeat(40)}`;
    renderPanel({ wsLog: { ...OK, stdout: `applied 2 files\n${secret}` }, wsLogCompletedAt: Date.now() });
    const details = within(panel()).getByRole("button", { name: "Details" });
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy output" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain("applied 2 files");
    expect(copied).not.toContain("a".repeat(40));
    details.focus();
    fireEvent.keyDown(details, { key: "Escape" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers Undo last update only when the run left a transaction", () => {
    const onRollback = vi.fn();
    renderPanel({ wsLog: OK, wsLogCompletedAt: Date.now() });
    expect(within(panel()).queryByRole("button", { name: /Undo/ })).toBeNull();
    cleanup();
    renderPanel({ wsLog: OK, wsLogCompletedAt: Date.now(), rollbackTransactionId: "1710000000000", onRollback });
    fireEvent.click(within(panel()).getByRole("button", { name: "Undo last update…" }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it("announces the outcome of a finished run as a status", () => {
    renderPanel({ wsLog: OK, wsLogCompletedAt: Date.now() });
    const status = within(panel()).getByRole("status");
    expect(status.textContent).toContain("Done");
    cleanup();
    renderPanel({ wsLog: FAILED, wsLogCompletedAt: Date.now() });
    expect(within(panel()).getByRole("status").textContent).toContain("Failed");
  });

  it("hands focus to the page's default pane when the result is dismissed", () => {
    function Page() {
      const [log, setLog] = useState<ActionResult | null>(OK);
      return (
        <>
          <section data-pane-id="page" data-keyscope="pane" data-pane-default="" tabIndex={-1}>
            <button type="button" data-pane-primary="">page</button>
          </section>
          <RunPanel wsRunning={null} wsLog={log} wsLogCompletedAt={Date.now()} onClear={() => setLog(null)} />
        </>
      );
    }
    renderWithShell(<Page />);
    const dismiss = within(panel()).getByRole("button", { name: "Dismiss" });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByRole("region", { name: "Run" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "page" }));
  });

  it("dismisses the finished result", () => {
    const onClear = vi.fn();
    renderPanel({ wsLog: OK, wsLogCompletedAt: Date.now(), onClear });
    fireEvent.click(within(panel()).getByRole("button", { name: "Dismiss" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("checks again on r while focus is in the panel, and not while a task runs", () => {
    const onRefresh = vi.fn();
    renderPanel({ wsLog: OK, wsLogCompletedAt: Date.now(), onRefresh });
    const details = within(panel()).getByRole("button", { name: "Details" });
    details.focus();
    fireEvent.keyDown(details, { key: "r" });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
