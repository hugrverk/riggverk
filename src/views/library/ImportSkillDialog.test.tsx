import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImportCandidate, SkillImportPreview, SkillSummary } from "../../types";
import { ImportSkillDialog } from "./ImportSkillDialog";

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});

afterEach(cleanup);

const HOSTILE = "---\nname: git-context\ndescription: d\nallowed-tools: Bash(git *)\n---\n# Heading\n<img src=x onerror=alert(1)>\nBranch: !`git branch`\n";

function candidate(extra: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    key: "0", kind: "folder", source: "~/Downloads/git-context", name: "git-context", description: "Git context.", license: "MIT", compatibility: "",
    files: [{ path: "SKILL.md", size: 120, executable: false, binary: false, problem: null }, { path: "scripts/run.sh", size: 20, executable: true, binary: false, problem: null }],
    omitted: [".git"],
    flags: [
      { kind: "unicode", label: "hidden Unicode", detail: "1 invisible format character on lines 3" },
      { kind: "key", label: "allowed-tools", detail: "Bash(git *) · grants tool access without asking" },
      { kind: "shell", label: "! commands", detail: "line 8: Branch: !`git branch`" },
    ],
    problems: [], skill_md: HOSTILE, digest: "sha256:1", status: "new", collision: null, changes: [], ...extra,
  };
}

const SKILLS: SkillSummary[] = [{ id: "tdd", name: "tdd", description: "", path: "", group: "bundled", category: "", risk: "", targets: [], related: [] }];

function renderDialog(preview: SkillImportPreview) {
  const onPreview = vi.fn(async () => preview);
  const onCommit = vi.fn(async () => ({ imported: ["git-context"], updated: [] }));
  const onDone = vi.fn();
  render(
    <ImportSkillDialog dropped={null} dragging={false} skills={SKILLS} packsFolder="~/.config/riggverk/packs" onPreview={onPreview} onCommit={onCommit} onDone={onDone} onClose={() => {}} />,
  );
  const previewPath = async (path: string) => {
    fireEvent.change(screen.getByLabelText("Or give its path"), { target: { value: path } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("group", { name: "Skills found" });
  };
  return { onPreview, onCommit, onDone, previewPath };
}

describe("ImportSkillDialog", () => {
  it("shows the flags first, the files and the SKILL.md as plain text, and imports the previewed copy", async () => {
    const { onPreview, onCommit, onDone, previewPath } = renderDialog({ token: "t1", candidates: [candidate()], problems: [], folder: "~/.config/riggverk/packs/imported/skills" });
    await previewPath("~/Downloads/git-context");
    expect(onPreview).toHaveBeenCalledWith(["~/Downloads/git-context"]);
    const flags = screen.getByRole("list", { name: "What git-context does without asking" });
    expect(within(flags).getAllByRole("listitem").map(item => item.textContent)).toEqual([
      "allowed-tools · Bash(git *) · grants tool access without asking",
      "! commands · line 8: Branch: !`git branch`",
      "hidden Unicode · 1 invisible format character on lines 3",
    ]);
    const raw = screen.getByLabelText("SKILL.md of git-context");
    expect(raw.tagName).toBe("PRE");
    expect(raw.textContent).toBe(HOSTILE);
    expect(raw.querySelector("img, h1")).toBeNull();
    expect(screen.getByText(".git")).toBeInTheDocument();
    expect(screen.getByText("Goes into pack:imported. Agents get it at the next Update, where you review it again.")).toBeInTheDocument();
    expect(screen.getByText("git clone <url> ~/.config/riggverk/packs/<name>")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ imported: ["git-context"], updated: [] }));
    expect(onCommit).toHaveBeenCalledWith("t1", ["0"], {});
  });

  it("imports a bundled name only under a valid other name, which it sends as a rename", async () => {
    const { onCommit, onDone, previewPath } = renderDialog({ token: "t2", candidates: [candidate({ name: "tdd", collision: "bundled", flags: [] })], problems: [], folder: "" });
    await previewPath("~/Downloads/tdd");
    const rename = screen.getByLabelText("Import as");
    expect(rename).toHaveValue("tdd-imported");
    fireEvent.change(rename, { target: { value: "tdd" } });
    expect(screen.getByText("A bundled skill is named tdd. Choose another name.")).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(importButton);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(rename, { target: { value: "my-tdd" } });
    // The dialog shows the SKILL.md that will be written: the name line changed, nothing else.
    const diff = screen.getByRole("group", { name: "SKILL.md of tdd as it will be written" });
    expect(diff.textContent).toContain("name: git-context");
    expect(diff.textContent).toContain("name: my-tdd");
    expect(screen.getByLabelText("SKILL.md of tdd").textContent).toBe(HOSTILE.replace("name: git-context", "name: my-tdd"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onCommit).toHaveBeenCalledWith("t2", ["0"], { "0": "my-tdd" });
  });

  it("lists refused skills with the reason and no checkbox to tick, and shows the diff of an import in place", async () => {
    const refused = candidate({ key: "1", name: "Bad_Name", status: "refused", problems: ["the name does not follow the Agent Skills rule"], flags: [], skill_md: "" });
    const update = candidate({ status: "update", flags: [], changes: [{ path: "SKILL.md", change: "changed", before: "one\n", after: "two\n" }] });
    const { previewPath } = renderDialog({ token: "t3", candidates: [update, refused], problems: ["~/x: no SKILL.md in it"], folder: "" });
    await previewPath("~/Downloads/repo");
    expect(screen.getByRole("checkbox", { name: "Bad_Name" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "git-context" })).toBeChecked();
    expect(screen.getByText("the name does not follow the Agent Skills rule")).toBeInTheDocument();
    expect(screen.getByText("~/x: no SKILL.md in it")).toBeInTheDocument();
    expect(screen.getByText(/update · replaces the import in place/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "SKILL.md against the import in place" })).toBeInTheDocument();
  });

  it("keeps the backend's refusal in the dialog and asks for a new preview", async () => {
    const { onCommit, previewPath } = renderDialog({ token: "t4", candidates: [candidate({ flags: [] })], problems: [], folder: "" });
    onCommit.mockRejectedValueOnce(new Error("the skill or the import in place changed since the preview; preview it again"));
    await previewPath("~/Downloads/git-context");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed since the preview");
    expect(screen.getByRole("button", { name: "Import" })).toHaveAttribute("aria-disabled", "true");
  });
});
