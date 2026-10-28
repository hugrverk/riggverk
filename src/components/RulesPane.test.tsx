import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInlineRulesState, type RulesFlow, type RulesReviewState } from "../hooks/useRulesFlow";
import { renderInFrame } from "../test/renderWithShell";
import type { RulesConversionPreview, RulesDiffView } from "../types";
import { RulesPane } from "./RulesPane";

afterEach(cleanup);

const DIFF: RulesDiffView = {
  surface: "codex_rules",
  mode: "edits",
  from_label: "shipped base sha256:abc",
  to_label: "installed",
  applicable: true,
  note: null,
  compared_base: null,
  added: 1,
  removed: 1,
  truncated: true,
  diff: "--- shipped base sha256:abc\n+++ installed\n@@ -1,1 +1,1 @@\n-old\n+new\n",
};

const PREVIEW: RulesConversionPreview = {
  surface: "codex_rules",
  applicable: true,
  reason: null,
  origin: "legacy_file",
  compared_base: "sha256:abc",
  compared_base_changed_lines: 11,
  moved_sections: [],
  removed_sections: ["## Priority"],
  result: "BEGIN\nbase\nEND\n",
  diff: "--- installed\n+++ after conversion\n@@ -1,1 +1,3 @@\n+BEGIN\n",
  diff_truncated: true,
  plan_fingerprint: "fp-1",
  preview_token: "tok-1",
};

function flowOf(state: RulesReviewState): RulesFlow {
  return {
    state,
    open: state.status !== "idle",
    inline: isInlineRulesState(state),
    reviewing: state.status !== "idle" && !isInlineRulesState(state),
    openDiff: vi.fn(async () => {}),
    openConversion: vi.fn(async () => {}),
    switchDiffMode: vi.fn(async () => {}),
    close: vi.fn(),
    apply: vi.fn(),
    retry: vi.fn(async () => {}),
  };
}

function renderPane(state: RulesReviewState, options: { busyLabel?: string | null; canConvert?: boolean } = {}) {
  const flow = flowOf(state);
  renderInFrame(<RulesPane flow={flow} busyLabel={options.busyLabel ?? null} canConvert={options.canConvert ?? true} backupRoot="/tmp/backups" />);
  return flow;
}

function press(key: string) {
  const pane = screen.getByRole("region", { name: "Rules review" });
  act(() => (pane.querySelector<HTMLElement>("[data-pane-primary]") ?? pane).focus());
  fireEvent.keyDown(document.activeElement!, { key });
}

describe("RulesPane", () => {
  it("shows progress while a diff is computed, and offers no write", () => {
    renderPane({ status: "loading", surface: "codex_rules", what: "diff" });
    expect(screen.getAllByText(/computing the diff for codex rules/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /apply/ })).toBeNull();
  });

  it("shows a diff read-only: y does nothing, t and v are offered, n closes", () => {
    const flow = renderPane({ status: "diff", surface: "codex_rules", diff: DIFF });
    const pane = screen.getByRole("region", { name: "Rules review" });
    expect(pane.textContent).toContain("The diff is cut at 64 KB");
    expect(within(pane).queryByRole("button", { name: /apply/ })).toBeNull();
    press("y");
    expect(flow.apply).not.toHaveBeenCalled();
    press("t");
    expect(flow.switchDiffMode).toHaveBeenCalledTimes(1);
    press("v");
    expect(flow.openConversion).toHaveBeenCalledWith("codex_rules");
    press("n");
    expect(flow.close).toHaveBeenCalledTimes(1);
  });

  it("does not offer conversion from the diff when the file cannot be converted", () => {
    const flow = renderPane({ status: "diff", surface: "codex_rules", diff: DIFF }, { canConvert: false });
    expect(screen.queryByRole("button", { name: /convert/ })).toBeNull();
    press("v");
    expect(flow.openConversion).not.toHaveBeenCalled();
  });

  it("previews a conversion with y to apply and never on Enter; f switches to the resulting file", () => {
    const flow = renderPane({ status: "conversion", surface: "codex_rules", preview: PREVIEW });
    const pane = screen.getByRole("region", { name: "Rules review" });
    expect(pane.textContent).toContain("a plain file that matches no shipped base");
    expect(pane.textContent).toContain("nothing moves; text around the block stays where it is");
    expect(pane.textContent).toContain("1 base section your file lacked: ## Priority");
    expect(pane.textContent).toContain("The diff is cut at 64 KB; the resulting file is still written in full.");
    press("Enter");
    expect(flow.apply).not.toHaveBeenCalled();
    press("f");
    expect(screen.getByLabelText("Resulting file").textContent).toBe("BEGIN\nbase\nEND\n");
    press("y");
    expect(flow.apply).toHaveBeenCalledTimes(1);
  });

  it("holds apply while another task runs and says why", () => {
    const flow = renderPane({ status: "conversion", surface: "codex_rules", preview: PREVIEW }, { busyLabel: "uninstall" });
    const apply = within(screen.getByLabelText("Status bar")).getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("title")).toBe("uninstall is running");
    press("y");
    expect(flow.apply).not.toHaveBeenCalled();
  });

  it("holds apply for a preview without a token", () => {
    const flow = renderPane({ status: "conversion", surface: "codex_rules", preview: { ...PREVIEW, preview_token: null } });
    press("y");
    expect(flow.apply).not.toHaveBeenCalled();
  });

  it("cannot be cancelled while it applies", () => {
    const flow = renderPane({ status: "applying", surface: "codex_rules", preview: PREVIEW });
    expect(screen.getByText("applying: backing up, then writing…")).toBeTruthy();
    press("n");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(flow.close).not.toHaveBeenCalled();
    expect(flow.apply).not.toHaveBeenCalled();
  });

  it("explains a failure, says nothing was written, and offers to open the review again", () => {
    const flow = renderPane({ status: "error", surface: "codex_rules", what: "apply", message: "Preview token expired" });
    expect(screen.getByRole("alert").textContent).toContain("Preview token expired");
    expect(screen.getByText("nothing was written")).toBeTruthy();
    press("r");
    expect(flow.retry).toHaveBeenCalledTimes(1);
  });

  it("shows the CONFIRM mode while it is open", () => {
    renderPane({ status: "diff", surface: "codex_rules", diff: DIFF });
    expect(document.querySelector(".statusbar .mode")!.textContent).toBe("CONFIRM");
  });

  describe("confirm line buttons", () => {
    const confirmLine = () => within(screen.getByRole("region", { name: "Rules review" }).querySelector<HTMLElement>(".pane-foot")!);

    it("ask the question with apply and cancel beside it; apply runs what y runs, cancel what n runs", () => {
      const flow = renderPane({ status: "conversion", surface: "codex_rules", preview: PREVIEW });
      const footer = screen.getByRole("region", { name: "Rules review" }).querySelector(".pane-foot")!;
      expect(footer.querySelector(".q")!.textContent).toBe("convert codex rules: write the file shown?");
      expect(Array.from(footer.querySelectorAll("button.tbtn")).map(button => button.textContent)).toEqual(["yapply", "ncancel"]);
      expect(confirmLine().getByRole("button", { name: "apply" }).classList.contains("tbtn-primary")).toBe(true);
      fireEvent.click(confirmLine().getByRole("button", { name: "apply" }));
      expect(flow.apply).toHaveBeenCalledTimes(1);
      fireEvent.click(confirmLine().getByRole("button", { name: "cancel" }));
      expect(flow.close).toHaveBeenCalledTimes(1);
    });

    it("never apply on Enter, on the pane, on the cancel button or on the apply button itself", () => {
      const flow = renderPane({ status: "conversion", surface: "codex_rules", preview: PREVIEW });
      press("Enter");
      fireEvent.keyDown(confirmLine().getByRole("button", { name: "cancel" }), { key: "Enter" });
      expect(flow.apply).not.toHaveBeenCalled();
      const apply = confirmLine().getByRole("button", { name: "apply" });
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Enter" })).toBe(false);
      expect(flow.apply).not.toHaveBeenCalled();
    });

    it("state the consequences beside a conversion, and nothing beside a read-only diff", () => {
      renderPane({ status: "conversion", surface: "codex_rules", preview: PREVIEW });
      expect(confirmLine().getByText("Preview first")).toBeTruthy();
      expect(confirmLine().getByText("Backed up")).toBeTruthy();
      expect(confirmLine().getByText("Undo any time")).toBeTruthy();
      cleanup();
      renderPane({ status: "diff", surface: "codex_rules", diff: DIFF });
      expect(screen.queryByText("Undo any time")).toBeNull();
    });

    it("hold apply for a running task or a preview without a token, with the reason", () => {
      const busy = renderPane({ status: "conversion", surface: "codex_rules", preview: PREVIEW }, { busyLabel: "uninstall" });
      const apply = confirmLine().getByRole("button", { name: "apply" });
      expect(apply.getAttribute("title")).toBe("uninstall is running");
      fireEvent.click(apply);
      expect(busy.apply).not.toHaveBeenCalled();
      cleanup();
      const tokenless = renderPane({ status: "conversion", surface: "codex_rules", preview: { ...PREVIEW, preview_token: null } });
      const held = confirmLine().getByRole("button", { name: "apply" });
      expect(held.getAttribute("title")).toBe("the preview has no token; open it again");
      fireEvent.click(held);
      expect(tokenless.apply).not.toHaveBeenCalled();
    });

    it("offer only close beside a read-only diff", () => {
      const flow = renderPane({ status: "diff", surface: "codex_rules", diff: DIFF });
      expect(confirmLine().queryByRole("button", { name: "apply" })).toBeNull();
      fireEvent.click(confirmLine().getByRole("button", { name: "close" }));
      expect(flow.close).toHaveBeenCalledTimes(1);
    });

    it("lock while the conversion is applied", () => {
      const flow = renderPane({ status: "applying", surface: "codex_rules", preview: PREVIEW });
      const apply = confirmLine().getByRole("button", { name: "apply" });
      const cancel = confirmLine().getByRole("button", { name: "cancel" });
      expect(apply.getAttribute("title")).toBe("applying…");
      expect(cancel.getAttribute("title")).toBe("applying; it cannot be cancelled");
      fireEvent.click(apply);
      fireEvent.click(cancel);
      expect(flow.apply).not.toHaveBeenCalled();
      expect(flow.close).not.toHaveBeenCalled();
    });
  });
});
