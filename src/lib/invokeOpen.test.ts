import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeOpen } from "./invokeOpen";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("invokeOpen", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes the command and arguments through and stays silent on success", async () => {
    invoke.mockResolvedValue({ success: true, action: "open_doc", stdout: "", stderr: "", exit_code: 0 });
    const setError = vi.fn();

    await invokeOpen("open_doc", { id: "doc-a" }, "Open doc", setError);

    expect(invoke).toHaveBeenCalledWith("open_doc", { id: "doc-a" });
    expect(setError).not.toHaveBeenCalled();
  });

  it("surfaces stderr when the opener reports a soft failure", async () => {
    invoke.mockResolvedValue({ success: false, action: "open_doc", stdout: "", stderr: "no app for .md\n", exit_code: 1 });
    const setError = vi.fn();

    await invokeOpen("open_doc", { id: "doc-a" }, "Open doc", setError);

    expect(setError).toHaveBeenCalledWith("Open doc: no app for .md");
  });

  it("uses a generic message when a failed open has no stderr", async () => {
    invoke.mockResolvedValue({ success: false, action: "open_doc", stdout: "", stderr: "", exit_code: 1 });
    const setError = vi.fn();

    await invokeOpen("open_doc", undefined, "Open", setError);

    expect(setError).toHaveBeenCalledWith("Open: could not open");
  });

  it("surfaces a rejected command", async () => {
    invoke.mockRejectedValue("path escapes workspace");
    const setError = vi.fn();

    await invokeOpen("open_doc", { id: "custom:x" }, "Open", setError);

    expect(setError).toHaveBeenCalledWith("Open: path escapes workspace");
  });
});
