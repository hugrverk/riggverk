import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackLibrary } from "../../types";
import { PackNotice } from "./PackNotice";

const library: PackLibrary = {
  folder: "~/.config/riggverk/packs",
  packs: [
    { name: "mine", state: "ok", reason: "", forgettable: false },
    { name: "gone", state: "missing", reason: "the pack folder is gone", forgettable: true },
  ],
  skills: [],
  ignored: [],
};

describe("PackNotice", () => {
  afterEach(cleanup);

  it("renders nothing while every pack is fine", () => {
    const { container } = render(
      <PackNotice library={{ ...library, packs: [library.packs[0]!] }} onForgetPack={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Forget pack for a pack whose installed skills are kept", () => {
    const onForgetPack = vi.fn();
    render(<PackNotice library={library} onForgetPack={onForgetPack} />);
    expect(screen.getByText("pack:gone")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forget pack" }));
    expect(onForgetPack).toHaveBeenCalledWith("gone");
  });

  it("says why a pack was refused and which folders in packs/ were ignored", () => {
    render(
      <PackNotice
        library={{
          ...library,
          packs: [
            { name: "loose", state: "refused", reason: "refusing a pack folder that is writable by its group or by everyone", forgettable: false },
          ],
          ignored: [{ name: "Bad_Name", reason: "not a pack name (lowercase letters, digits and hyphens, at most 64)" }],
        }}
        onForgetPack={() => {}}
      />,
    );
    expect(screen.getByText("pack:loose")).toBeInTheDocument();
    expect(screen.getByText(/writable by its group/)).toBeInTheDocument();
    expect(screen.getByText("~/.config/riggverk/packs/Bad_Name")).toBeInTheDocument();
    expect(screen.getByText(/not a pack name/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget pack" })).toBeNull();
  });

  it("shows a pack list that failed instead of swallowing it, and an unusable record", () => {
    const { rerender } = render(<PackNotice library={null} error="no data folder" onForgetPack={() => {}} />);
    expect(screen.getByText("could not be listed: no data folder")).toBeInTheDocument();
    rerender(
      <PackNotice
        library={{ ...library, packs: [], record_problem: "pack-skills.json cannot be read" }}
        onForgetPack={() => {}}
      />,
    );
    expect(screen.getByText("pack-skills.json cannot be read")).toBeInTheDocument();
  });
});
