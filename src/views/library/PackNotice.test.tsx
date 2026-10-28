import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
