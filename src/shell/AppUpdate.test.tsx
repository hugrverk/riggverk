import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdate } from "../hooks/useAppUpdate";
import { AppUpdateOverlay, UpdateConsentCard } from "./AppUpdate";

afterEach(cleanup);

function fakeUpdate(overrides: Partial<AppUpdate> = {}): AppUpdate {
  return {
    configured: true,
    consentNeeded: false,
    available: null,
    review: null,
    checking: false,
    progress: null,
    installing: false,
    installError: null,
    installBlocked: false,
    chooseDaily: vi.fn(),
    notNow: vi.fn(),
    setChoice: vi.fn(),
    checkNow: vi.fn(),
    openReview: vi.fn(),
    closeReview: vi.fn(),
    install: vi.fn(),
    ...overrides,
  };
}

const AVAILABLE = {
  status: "available" as const,
  version: "2026.11.7",
  current_version: "2026.11.6",
  notes: "## New\n\n- <img src=x onerror=alert(1)> **bold** [site](https://example.com) [file](file:///etc/passwd)\n",
  date: null,
  app_path: "/Applications/Riggverk.app",
  blocked: null,
};

describe("UpdateConsentCard", () => {
  it("asks once, saying what is sent", () => {
    const update = fakeUpdate({ consentNeeded: true });
    render(<UpdateConsentCard update={update} />);
    expect(screen.getByText(/It sends no data about you or your setup/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check daily" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(update.chooseDaily).toHaveBeenCalledTimes(1);
    expect(update.notNow).toHaveBeenCalledTimes(1);
  });

  it("is gone once chosen", () => {
    const { container } = render(<UpdateConsentCard update={fakeUpdate()} />);
    expect(container.textContent).toBe("");
  });
});

describe("AppUpdateOverlay", () => {
  it("renders the notes as safe markdown, says what is replaced, and installs on Download and restart", () => {
    const update = fakeUpdate({ available: AVAILABLE, review: { kind: "available", update: AVAILABLE } });
    render(<AppUpdateOverlay update={update} />);
    const dialog = screen.getByRole("dialog", { name: "Riggverk 2026.11.7" });
    expect(screen.getByRole("heading", { name: "New" })).not.toBeNull();
    expect(dialog.querySelector("li strong")?.textContent).toBe("bold");
    expect(dialog.textContent).not.toContain("## New");
    // HTML in the unsigned notes is never rendered as HTML.
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("[onerror]")).toBeNull();
    // Only http(s) links are links; anything else is blocked text.
    expect(screen.getByRole("link", { name: "site" }).getAttribute("href")).toBe("https://example.com");
    expect(screen.queryByRole("link", { name: "file" })).toBeNull();
    expect(dialog.textContent).toContain("/Applications/Riggverk.app");
    expect(dialog.textContent).toContain("only the app is replaced");
    fireEvent.click(screen.getByRole("button", { name: "Download and restart" }));
    expect(update.install).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(update.closeReview).toHaveBeenCalledTimes(1);
  });

  it("says so when a release has no notes", () => {
    const bare = { ...AVAILABLE, notes: "  " };
    render(<AppUpdateOverlay update={fakeUpdate({ available: bare, review: { kind: "available", update: bare } })} />);
    expect(screen.getByText("No release notes.")).not.toBeNull();
  });

  it("names why an app that cannot be replaced must be moved first, and does not install", () => {
    const blocked = { ...AVAILABLE, blocked: "Move Riggverk to Applications first." };
    const update = fakeUpdate({ available: blocked, review: { kind: "available", update: blocked } });
    render(<AppUpdateOverlay update={update} />);
    expect(screen.getByText("Move Riggverk to Applications first.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download and restart" }));
    expect(update.install).not.toHaveBeenCalled();
  });

  it("answers a check that found nothing new", () => {
    render(<AppUpdateOverlay update={fakeUpdate({ review: { kind: "up_to_date", version: "2026.11.6" } })} />);
    expect(screen.getByText("Riggverk 2026.11.6 is the newest version.")).not.toBeNull();
  });
});
