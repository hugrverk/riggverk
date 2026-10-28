import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function group() {
  return screen.getByText(/^security ·/);
}

describe("SecurityPostureRows", () => {
  it("asks for the posture of its harness and shows risky rows in warn", async () => {
    invokeMock.mockResolvedValue(RISKY_CLAUDE);
    const { container } = render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · 1 risky"));
    expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "claude" });
    expect(group().querySelector(".c-warn")).not.toBeNull();
    const dd = container.querySelector("dd.c-warn")!;
    expect(dd.textContent).toBe("risky · starts in bypassPermissions mode: no permission prompts");
    expect(container.querySelectorAll("dt")[0]!.textContent).toBe("bypass mode");
  });

  it("shows a clean config as dim text that checks config only", async () => {
    invokeMock.mockResolvedValue(CLEAN_CODEX);
    const { container } = render(<SecurityPostureRows harness="codex" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · no risky settings found in ~/.codex/config.toml · this checks config only"));
    expect(group().querySelector(".c-dim")).not.toBeNull();
    expect(container.querySelector(".c-ok")).toBeNull();
    expect(container.textContent).toContain("enforced · sandbox_mode is workspace-write");
  });

  it("says defaults apply when the file is missing", async () => {
    invokeMock.mockResolvedValue(postureOf("codex", [["codex_sandbox_unset", "advice"], ["config_only", "not_covered"]], [{ file: "~/.codex/config.toml", state: "missing" }]));
    render(<SecurityPostureRows harness="codex" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · no ~/.codex/config.toml · defaults apply · config only"));
  });

  it("says it could not read an unreadable file, with no rows from it", async () => {
    invokeMock.mockResolvedValue(postureOf("claude", [["config_only", "not_covered"]], [{ file: "~/.claude/settings.json", state: "unreadable" }]));
    render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · could not read ~/.claude/settings.json"));
  });

  it("shows Copilot as not covered, without any file", async () => {
    invokeMock.mockResolvedValue(postureOf("copilot", [["copilot_not_covered", "not_covered"]], []));
    const { container } = render(<SecurityPostureRows harness="copilot" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · not covered"));
    expect(container.querySelector("dd")!.textContent).toContain("Riggverk reads no Copilot setting");
  });

  it("shows the could-not-read verdict when the call fails or answers with nothing", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const first = render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · could not read config"));
    expect(first.container.textContent).not.toContain("boom");
    first.unmount();

    invokeMock.mockResolvedValue(undefined);
    render(<SecurityPostureRows harness="claude" refreshKey="a" />);
    await waitFor(() => expect(group().textContent).toBe("security · could not read config"));
  });

  it("reads again when the refresh key changes and drops a response that arrives late", async () => {
    let resolveFirst: (value: SecurityPosture) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise<SecurityPosture>(resolve => (resolveFirst = resolve)));
    invokeMock.mockResolvedValueOnce(CLEAN_CODEX);
    const { rerender } = render(<SecurityPostureRows harness="codex" refreshKey="a" />);
    rerender(<SecurityPostureRows harness="codex" refreshKey="b" />);
    await waitFor(() => expect(group().textContent).toContain("no risky settings found"));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    resolveFirst(postureOf("codex", [["codex_no_sandbox", "risky"]]));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(group().textContent).not.toContain("1 risky");
    expect(group().textContent).toContain("no risky settings found");
  });
});
