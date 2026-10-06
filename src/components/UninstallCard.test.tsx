import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UninstallPlanView } from "../types";
import { UninstallCard } from "./UninstallCard";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const PLAN: UninstallPlanView = {
  removable: [{ label: "claude rules", path: "~/.claude/CLAUDE.md" }],
  preserved: [{ label: "cursor mcp", path: "~/.cursor/mcp.json" }],
  merged: [],
  summary: "1 removable, 1 preserved",
  plan_fingerprint: "uninstall-fp",
  preview_token: "uninstall-token",
};

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(PLAN);
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

function renderCard(props: Partial<Parameters<typeof UninstallCard>[0]> = {}) {
  const onApply = vi.fn();
  const utils = render(<UninstallCard workspaceValid busy={false} onApply={onApply} {...props} />);
  return { onApply, ...utils };
}

describe("UninstallCard", () => {
  it("renders nothing without a valid workspace", () => {
    const { container } = renderCard({ workspaceValid: false });
    expect(container.firstChild).toBeNull();
  });

  it("previews first and only applies the reviewed fingerprint and token after confirming", async () => {
    const { onApply } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /preview uninstall/i }));
    await waitFor(() => expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("preview_uninstall");
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: /uninstall everything/i, hidden: true }));
    expect(onApply).toHaveBeenCalledWith("uninstall-fp", "uninstall-token");
  });

  it("opens the preview when :uninstall asks for it, once", async () => {
    const handled = vi.fn();
    const { rerender } = renderCard();
    rerender(<UninstallCard workspaceValid busy={false} onApply={vi.fn()} previewRequested onPreviewRequestHandled={handled} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("preview_uninstall"));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);

    rerender(<UninstallCard workspaceValid busy={false} onApply={vi.fn()} previewRequested={false} onPreviewRequestHandled={handled} />);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not open the preview for a request that arrives while a task runs", async () => {
    const handled = vi.fn();
    const { rerender } = renderCard({ busy: true });
    rerender(<UninstallCard workspaceValid busy onApply={vi.fn()} previewRequested onPreviewRequestHandled={handled} />);
    await waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows a failing preview in the card", async () => {
    invokeMock.mockRejectedValue(new Error("hash failed"));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /preview uninstall/i }));
    expect((await screen.findByRole("status")).textContent).toBe("hash failed");
  });
});
