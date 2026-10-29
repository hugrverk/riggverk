import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceCards } from "./ChoiceCards";
import { Fold } from "./Fold";
import { SideBySideDiff } from "./SideBySideDiff";

afterEach(cleanup);

describe("Fold", () => {
  it("scrolls itself into view when it opens, and does not take focus", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(
        <>
          <button type="button">Compare</button>
          <Fold id="f" label="Compare CLAUDE.md">
            <p>Computing the diff…</p>
          </Fold>
        </>,
      );
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("group", { name: "Compare CLAUDE.md" }));
      expect(document.activeElement).toBe(document.body);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("ChoiceCards", () => {
  const choices = (onMerge = vi.fn(), onKeep = vi.fn()) => [
    { id: "merge", title: "Merge in updates", sub: "Riggverk’s rules go in a managed block.", keyName: "v", onChoose: onMerge },
    { id: "keep", title: "Keep mine", sub: "Riggverk never writes this file.", keyName: "m", disabled: "update claude is running", onChoose: onKeep },
  ];

  it("names each card by its title and describes it with its sentence, and lists what is promised", () => {
    render(<ChoiceCards label="Resolve CLAUDE.md" choices={choices()} consequences={["Preview first", "Backed up", "Undo any time"]} />);
    const group = screen.getByRole("group", { name: "Resolve CLAUDE.md" });
    const merge = within(group).getByRole("button", { name: "Merge in updates" });
    expect(merge.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(merge.getAttribute("aria-describedby")!)!.textContent).toBe("Riggverk’s rules go in a managed block.");
    expect(document.querySelector(".hp-conseq")!.textContent).toBe("Preview firstBacked upUndo any time");
  });

  it("runs the choice on a click, and never for a disabled card, which keeps its reason as the tooltip", () => {
    const onMerge = vi.fn();
    const onKeep = vi.fn();
    render(<ChoiceCards label="Resolve" choices={choices(onMerge, onKeep)} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge in updates" }));
    expect(onMerge).toHaveBeenCalledTimes(1);
    const keep = screen.getByRole("button", { name: "Keep mine" });
    expect(keep.getAttribute("aria-disabled")).toBe("true");
    expect(keep.getAttribute("title")).toBe("update claude is running");
    fireEvent.click(keep);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("shows the keys only while its cell is the active one", () => {
    const { rerender } = render(<ChoiceCards label="Resolve" choices={choices()} />);
    expect(screen.getByRole("button", { name: "Merge in updates" }).getAttribute("aria-keyshortcuts")).toBeNull();
    expect(document.querySelector("kbd")).toBeNull();
    rerender(<ChoiceCards label="Resolve" choices={choices()} active />);
    expect(screen.getByRole("button", { name: "Merge in updates" }).getAttribute("aria-keyshortcuts")).toBe("v");
    expect(Array.from(document.querySelectorAll("kbd")).map(kbd => kbd.textContent)).toEqual(["v", "m"]);
  });
});

describe("Fold", () => {
  it("is a named group with the id a button's aria-controls points to", () => {
    render(
      <Fold id="compare-1" label="Compare CLAUDE.md with Riggverk’s rules">
        <p>inside</p>
      </Fold>,
    );
    const fold = screen.getByRole("group", { name: "Compare CLAUDE.md with Riggverk’s rules" });
    expect(fold.id).toBe("compare-1");
    expect(within(fold).getByText("inside")).toBeTruthy();
  });
});

describe("SideBySideDiff", () => {
  const DIFF = ["--- shipped base", "+++ installed", "@@ -1,2 +1,2 @@", " keep", "-old line", "+new line", ""].join("\n");

  it("lays the old text left and the new text right with the sign in its own column, and says what the sides are", () => {
    render(<SideBySideDiff diff={DIFF} label="shipped base to installed" empty="No differences." intro="Base on the left, yours on the right." />);
    const diff = screen.getByRole("group", { name: "shipped base to installed" });
    expect(diff.classList.contains("diff-split")).toBe(true);
    expect(screen.getByText("Base on the left, yours on the right.")).toBeTruthy();
    const row = Array.from(diff.querySelectorAll(".diff-row")).find(candidate => candidate.querySelector(".remove"))!;
    expect(row.children[0]!.querySelector(".diff-mark")!.textContent).toBe("-");
    expect(row.children[0]!.querySelector(".diff-text")!.textContent).toBe("old line");
    expect(row.children[1]!.querySelector(".diff-mark")!.textContent).toBe("+");
    expect(row.children[1]!.querySelector(".diff-text")!.textContent).toBe("new line");
  });

  it("shows the backend's notes, the cut one as a warning, and the empty text when nothing differs", () => {
    render(
      <SideBySideDiff
        diff=""
        label="d"
        empty="No differences."
        notes={[{ text: "compared with the closest shipped base" }, { text: "The diff is cut at 64 KB; the rest is not shown.", tone: "warn" }]}
      />,
    );
    expect(screen.getByText("No differences.").tagName).toBe("P");
    expect(screen.getByText("compared with the closest shipped base").className).toBe("hp-sbs-note");
    expect(screen.getByText("The diff is cut at 64 KB; the rest is not shown.").className).toContain("hp-sbs-warn");
  });

  it("masks token shapes when asked, as a file diff does", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const diff = ["--- yours", "+++ bundled", "@@ -1,1 +1,1 @@", `-token ${token}`, "+token [x]", ""].join("\n");
    const { rerender } = render(<SideBySideDiff diff={diff} label="d" empty="none" redact />);
    expect(document.body.textContent).not.toContain(token);
    rerender(<SideBySideDiff diff={diff} label="d" empty="none" />);
    expect(document.body.textContent).toContain(token);
  });
});
