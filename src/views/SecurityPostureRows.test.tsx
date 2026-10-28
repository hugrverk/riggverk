import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAN_CODEX, postureOf, RISKY_CLAUDE } from "../test/pageFixtures";
import type { SecurityPosture } from "../types";
import { SecurityPostureRows } from "./SecurityPostureRows";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

/** The zone and its verdict line. */
async function zone() {
  return screen.findByRole("region", { name: "Safety notes" });
}

function verdict(root: HTMLElement) {
  return root.querySelector(".hp-safety-verdict")!.textContent;
}

/** One finding as label, text and mark. */
function rowsOf(root: HTMLElement) {
  return Array.from(root.querySelectorAll(".hp-note-row")).map(row => [
    row.children[0]!.textContent,
    row.children[1]!.textContent,
    row.querySelector(".state-pill")?.textContent ?? null,
  ]);
}

describe("SecurityPostureRows", () => {
  it("asks for the posture of its harness and shows a risky finding as 'Worth a look', advice only", async () => {
    invokeMock.mockResolvedValue(RISKY_CLAUDE);
    render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    const notes = await zone();
    expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "claude" });
    // The zone says what it is: advice, never a state.
    expect(within(notes).getByText("Safety notes")).toBeTruthy();
    expect(notes.querySelector(".hp-safety-head .state-pill")!.textContent).toBe("Advice only");
    expect(verdict(notes)).toBe("1 risky");
    expect(rowsOf(notes)).toEqual([
      ["bypass mode", "starts in bypassPermissions mode: no permission prompts", "Worth a look"],
      ["sandbox", "sandbox.enabled is not true · shell commands run without the OS sandbox", "Tip"],
      [".env reads", "no Read deny rule names .env in permissions.deny", "Tip"],
      ["not checked", "project and managed config, profiles, command-line flags and aliases", null],
      ["baseline", "Library > Docs > Security Baseline", null],
    ]);
    // No hue and no state of its own: the pills are the quiet kind.
    expect(notes.querySelector(".state-pill.is-decide, .state-pill.is-fix")).toBeNull();
  });

  it("shows a clean config as plain text that checks config only, with 'Set' for what the file sets", async () => {
    invokeMock.mockResolvedValue(CLEAN_CODEX);
    render(<SecurityPostureRows harness="codex" refreshKey="a" />);
    const notes = await zone();
    expect(verdict(notes)).toBe("no risky settings found in ~/.codex/config.toml · this checks config only");
    expect(rowsOf(notes).slice(0, 2)).toEqual([
      ["sandbox", "sandbox_mode is workspace-write", "Set"],
      ["approvals", "approval_policy is on-request", "Set"],
    ]);
    expect(notes.querySelector(".state-pill.is-ok")!.textContent).toBe("Set");
  });

  it("says defaults apply when the file is missing", async () => {
    invokeMock.mockResolvedValue(postureOf("codex", [["codex_sandbox_unset", "advice"], ["config_only", "not_covered"]], [{ file: "~/.codex/config.toml", state: "missing" }]));
    render(<SecurityPostureRows harness="codex" refreshKey="a" />);
    expect(verdict(await zone())).toBe("no ~/.codex/config.toml · defaults apply · config only");
  });

  it("says it could not read an unreadable file, with no rows from it", async () => {
    invokeMock.mockResolvedValue(postureOf("claude", [["config_only", "not_covered"]], [{ file: "~/.claude/settings.json", state: "unreadable" }]));
    render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    const notes = await zone();
    expect(verdict(notes)).toBe("could not read ~/.claude/settings.json");
    expect(rowsOf(notes).map(row => row[0])).toEqual(["not checked", "baseline"]);
  });

  it("shows Copilot as not covered, without any file or mark", async () => {
    invokeMock.mockResolvedValue(postureOf("copilot", [["copilot_not_covered", "not_covered"]], []));
    render(<SecurityPostureRows harness="copilot" refreshKey="a" />);
    const notes = await zone();
    expect(verdict(notes)).toBe("not covered");
    expect(rowsOf(notes)[0]![1]).toContain("Riggverk reads no Copilot setting");
    expect(rowsOf(notes)[0]![2]).toBeNull();
  });

  it("shows the could-not-read verdict when the call fails or answers with nothing", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const first = render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    expect(verdict(await zone())).toBe("could not read config");
    expect(first.container.textContent).not.toContain("boom");
    first.unmount();

    invokeMock.mockResolvedValue(undefined);
    render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    expect(verdict(await zone())).toBe("could not read config");
  });

  it("reads again when the refresh key changes and drops a response that arrives late", async () => {
    let resolveFirst: (value: SecurityPosture) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise<SecurityPosture>(resolve => (resolveFirst = resolve)));
    invokeMock.mockResolvedValueOnce(CLEAN_CODEX);
    const { rerender } = render(<SecurityPostureRows harness="codex" refreshKey="a" />);
    rerender(<SecurityPostureRows harness="codex" refreshKey="b" />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Safety notes" }).textContent).toContain("no risky settings found"));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    resolveFirst(postureOf("codex", [["codex_no_sandbox", "risky"]]));
    await new Promise(resolve => setTimeout(resolve, 10));
    const notes = screen.getByRole("region", { name: "Safety notes" });
    expect(notes.textContent).not.toContain("1 risky");
    expect(notes.textContent).toContain("no risky settings found");
  });

  it("renders nothing while the first answer is still on its way", () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    expect(screen.queryByRole("region", { name: "Safety notes" })).toBeNull();
  });
});
