import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { renderWithShell } from "../test/renderWithShell";
import { Boot, resetBootLaunch, type BootInfo } from "./Boot";

const INFO: BootInfo = {
  version: "0.1.0",
  workspace: "/Users/me/agent-workspace",
  branch: "main",
  dirty: false,
  harnesses: ["codex", "claude"],
  backups: 3,
};

beforeEach(() => {
  vi.useFakeTimers();
  resetBootLaunch();
  document.documentElement.dataset.motion = "full";
});

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
  cleanup();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Advances in small steps until the sequence starts to fade out; returns what it said and how long that took. */
function playToEnd() {
  let elapsed = 0;
  while (overlay() && !overlay()!.classList.contains("out") && elapsed < 5000) {
    advance(10);
    elapsed += 10;
  }
  return { said: lines(), elapsed };
}

function overlay() {
  return document.querySelector(".boot");
}

function lines() {
  return [...document.querySelectorAll(".boot .ln")].map(line => line.textContent);
}

/** Registers a `u` binding next to the boot overlay, to see whether a key reaches the keymap. */
function WithBinding({ run, children }: { run: () => void; children: React.ReactNode }) {
  const bindings: Binding[] = [{ id: "t.u", keys: "u", title: "Update", scope: "global", run }];
  useKeymap(bindings);
  return <>{children}</>;
}

describe("Boot", () => {
  it("types the lines about the workspace, then fades away and calls onDone, in about a second and a half", () => {
    const onDone = vi.fn();
    renderWithShell(<Boot info={INFO} autoplay onDone={onDone} />);
    expect(overlay()!.getAttribute("aria-hidden")).toBe("true");

    advance(300);
    expect(lines().length).toBeGreaterThan(0);
    expect(overlay()).not.toBeNull();

    const { said, elapsed } = playToEnd();
    expect(said).toEqual([
      "❯ riggverk 0.1.0",
      "  workspace  /Users/me/agent-workspace",
      "  branch     main · clean",
      "  harnesses  codex · claude",
      "  backups    3 runs",
      "❯ ready",
    ]);
    expect(elapsed + 300).toBeGreaterThan(700);
    expect(elapsed + 300).toBeLessThan(1500);
    expect(onDone).not.toHaveBeenCalled();

    advance(250);
    expect(overlay()).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("is over within two seconds even when every line is long", () => {
    const longPath = `/Users/me/${"deeply/nested/".repeat(8)}workspace`;
    renderWithShell(<Boot info={{ ...INFO, workspace: longPath }} autoplay />);
    const { elapsed } = playToEnd();
    advance(250);
    expect(elapsed + 250).toBeLessThan(2000);
    expect(overlay()).toBeNull();
  });

  it("skips a line it has no data for, and says so for an unusable workspace folder and a dirty branch", () => {
    renderWithShell(<Boot info={{ version: "0.1.0", workspace: null, branch: "dev", dirty: true, backups: 1 }} autoplay />);
    expect(playToEnd().said).toEqual([
      "❯ riggverk 0.1.0",
      "  workspace  folder unusable",
      "  branch     dev · dirty",
      "  backups    1 run",
      "❯ ready",
    ]);
  });

  it("leaves out what is not known yet, and picks data up that arrives while it runs", () => {
    const { rerender } = renderWithShell(<Boot info={{}} autoplay />);
    advance(40);
    rerender(<Boot info={{ workspace: "/work" }} autoplay />);
    expect(playToEnd().said).toEqual(["❯ riggverk", "  workspace  /work", "❯ ready"]);
  });

  it("any key skips it at once and is not forwarded as a command", () => {
    const run = vi.fn();
    const onDone = vi.fn();
    renderWithShell(
      <WithBinding run={run}>
        <Boot info={INFO} autoplay onDone={onDone} />
      </WithBinding>,
    );
    advance(100);
    const notPrevented = fireEvent.keyDown(document.body, { key: "u" });
    expect(notPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(overlay()!.classList.contains("out")).toBe(true);

    advance(250);
    expect(overlay()).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);

    // The sequence no longer listens: the same key now reaches its binding.
    fireEvent.keyDown(document.body, { key: "u" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a click skips it too, and a bare modifier does not", () => {
    renderWithShell(<Boot info={INFO} autoplay />);
    advance(100);
    fireEvent.keyDown(document.body, { key: "Shift" });
    expect(overlay()!.classList.contains("out")).toBe(false);
    fireEvent.mouseDown(document.body);
    expect(overlay()!.classList.contains("out")).toBe(true);
    advance(250);
    expect(overlay()).toBeNull();
  });

  it("plays once per launch: a later mount does not replay it", () => {
    const first = renderWithShell(<Boot info={INFO} autoplay />);
    advance(2500);
    expect(overlay()).toBeNull();
    first.unmount();

    renderWithShell(<Boot info={INFO} autoplay />);
    expect(overlay()).toBeNull();
  });

  it("survives StrictMode's double mount and still plays", () => {
    renderWithShell(<Boot info={INFO} autoplay />, { strict: true });
    expect(playToEnd().said).toHaveLength(6);
    advance(250);
    expect(overlay()).toBeNull();
  });

  it("does not play on its own unless asked to (existing tests, and a bare mount, stay untouched)", () => {
    renderWithShell(<Boot info={INFO} />);
    advance(2500);
    expect(overlay()).toBeNull();
  });

  it("replays when run changes", () => {
    const { rerender } = renderWithShell(<Boot info={INFO} autoplay run={0} />);
    advance(2500);
    expect(overlay()).toBeNull();
    rerender(<Boot info={INFO} autoplay run={1} />);
    expect(playToEnd().said).toHaveLength(6);
    advance(250);
    expect(overlay()).toBeNull();
  });

  describe("motion levels", () => {
    it("subtle fades the shell in instead: a veil with no text that never takes a key", () => {
      document.documentElement.dataset.motion = "subtle";
      const run = vi.fn();
      const onDone = vi.fn();
      renderWithShell(
        <WithBinding run={run}>
          <Boot info={INFO} autoplay onDone={onDone} />
        </WithBinding>,
      );
      expect(overlay()!.classList.contains("veil")).toBe(true);
      expect(lines()).toEqual([]);
      fireEvent.keyDown(document.body, { key: "u" });
      expect(run).toHaveBeenCalledTimes(1);
      advance(250);
      expect(overlay()).toBeNull();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("off shows nothing at all", () => {
      document.documentElement.dataset.motion = "off";
      const onDone = vi.fn();
      renderWithShell(<Boot info={INFO} autoplay onDone={onDone} />);
      expect(overlay()).toBeNull();
      advance(2500);
      expect(onDone).not.toHaveBeenCalled();
    });

    it("does not replay under subtle or off", () => {
      document.documentElement.dataset.motion = "off";
      const { rerender } = renderWithShell(<Boot info={INFO} autoplay run={0} />);
      rerender(<Boot info={INFO} autoplay run={1} />);
      expect(overlay()).toBeNull();
      document.documentElement.dataset.motion = "subtle";
      rerender(<Boot info={INFO} autoplay run={2} />);
      expect(overlay()).toBeNull();
    });
  });
});
