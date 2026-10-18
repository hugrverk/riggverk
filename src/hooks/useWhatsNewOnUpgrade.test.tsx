import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseNotes } from "../lib/releaseNotes";
import { defaultSettings } from "../lib/settingsDraft";
import { renderInFrame } from "../test/renderWithShell";
import type { AppSettings } from "../types";
import { useWhatsNewOnUpgrade } from "./useWhatsNewOnUpgrade";

afterEach(cleanup);

const RELEASES: ReleaseNotes[] = [
  { version: "2026.10.2", sections: [{ title: "Fixes", items: ["Close the gap"] }] },
  {
    version: "2026.10.1",
    sections: [
      { title: "New", items: ["Manage the rules block", "Show skill copies"] },
      { title: "Fixes", items: ["Wait for the apply hint"] },
    ],
  },
  { version: "2026.9.1", sections: [{ title: "New", items: ["Older thing"] }] },
];

function Harness({
  settings,
  appVersion,
  recordVersion,
}: {
  settings: AppSettings | null;
  appVersion: string;
  recordVersion: (version: string) => void;
}) {
  useWhatsNewOnUpgrade({ settings, appVersion, recordVersion, releases: RELEASES });
  return <p>body</p>;
}

function setup(lastSeen: string | null | undefined, appVersion: string) {
  const recordVersion = vi.fn();
  const settings: AppSettings = { ...defaultSettings(), last_seen_version: lastSeen };
  const view = renderInFrame(<Harness settings={settings} appVersion={appVersion} recordVersion={recordVersion} />);
  const rerender = (next: AppSettings | null) =>
    view.rerenderFrame(<Harness settings={next} appVersion={appVersion} recordVersion={recordVersion} />);
  return { recordVersion, rerender, settings };
}

const overlay = () => screen.queryByRole("dialog", { name: "What's new" });

describe("useWhatsNewOnUpgrade", () => {
  it("shows the notes since the last seen version once after an update", () => {
    const { recordVersion } = setup("2026.9.1", "2026.10.2");

    const dialog = overlay()!;
    expect(dialog).not.toBeNull();
    const versions = within(dialog)
      .getAllByRole("region")
      .map(region => region.getAttribute("aria-label"));
    expect(versions).toEqual(["2026.10.2", "2026.10.1"]);
    expect(dialog.textContent).toContain("Manage the rules block");
    expect(dialog.textContent).toContain("Close the gap");
    expect(dialog.textContent).not.toContain("Older thing");
    // Nothing is recorded until it is closed.
    expect(recordVersion).not.toHaveBeenCalled();
  });

  it("records the current version when it is closed with Escape, and not before", () => {
    const { recordVersion } = setup("2026.9.1", "2026.10.2");

    fireEvent.keyDown(overlay()!, { key: "Escape" });

    expect(overlay()).toBeNull();
    expect(recordVersion).toHaveBeenCalledTimes(1);
    expect(recordVersion).toHaveBeenCalledWith("2026.10.2");
  });

  it("does not open again within the same launch", () => {
    const { recordVersion, rerender, settings } = setup("2026.9.1", "2026.10.2");
    fireEvent.keyDown(overlay()!, { key: "Escape" });

    rerender({ ...settings });
    rerender({ ...settings, last_seen_version: "2026.10.2" });

    expect(overlay()).toBeNull();
    expect(recordVersion).toHaveBeenCalledTimes(1);
  });

  it("does not show anything on a fresh install; it only records the version", () => {
    for (const unset of [null, undefined]) {
      const { recordVersion } = setup(unset, "2026.10.2");
      expect(overlay()).toBeNull();
      expect(recordVersion).toHaveBeenCalledTimes(1);
      expect(recordVersion).toHaveBeenCalledWith("2026.10.2");
      cleanup();
    }
  });

  it("does nothing when the version has not changed or went down", () => {
    for (const lastSeen of ["2026.10.2", "2026.11.1"]) {
      const { recordVersion } = setup(lastSeen, "2026.10.2");
      expect(overlay()).toBeNull();
      expect(recordVersion).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("records the version without an overlay when there are no notes for the versions in between", () => {
    const { recordVersion } = setup("2026.10.2", "2026.12.1");
    expect(overlay()).toBeNull();
    expect(recordVersion).toHaveBeenCalledWith("2026.12.1");
  });

  it("waits for the settings to load", () => {
    const recordVersion = vi.fn();
    const view = renderInFrame(<Harness settings={null} appVersion="2026.10.2" recordVersion={recordVersion} />);
    expect(overlay()).toBeNull();
    expect(recordVersion).not.toHaveBeenCalled();

    act(() => {
      view.rerenderFrame(
        <Harness settings={{ ...defaultSettings(), last_seen_version: "2026.9.1" }} appVersion="2026.10.2" recordVersion={recordVersion} />,
      );
    });

    expect(overlay()).not.toBeNull();
  });
});
