import { useEffect, useState } from "react";
import type { RulesFlow } from "../hooks/useRulesFlow";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { surfaceTitle } from "../lib/installPlan";
import { useConfirmMode, useStatusContext } from "../shell/ShellState";
import { BindingButton } from "../ui/BindingActionKey";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import type { RulesConversionPreview, RulesDiffView } from "../types";
import { DiffView } from "./DiffView";
import { ReviewFooter } from "./ReviewFooter";
import { ActivityLoader } from "./TerminalOutput";

export const RULES_PANE_ID = "rules";

export interface RulesPaneProps {
  flow: RulesFlow;
  /** Label of an unrelated workspace task that is running; apply waits for it. */
  busyLabel: string | null;
  /** Where backups are written, for the note under the conversion. */
  backupRoot?: string | null;
  /** Whether `v` (convert) is offered from the diff: the file is a conflict the app can convert. */
  canConvert: boolean;
  /** The pane that takes the keyboard back when the review closes. Default `surfaces`. */
  returnPaneId?: string;
}

const ERROR_HINT = {
  diff: "The diff could not be computed. Nothing was written.",
  conversion: "The conversion preview could not be computed. Nothing was written.",
  apply: "The backend refused this conversion before it ran. Nothing was written; preview again to review the file as it is now.",
} as const;

const ORIGIN_TEXT = {
  legacy_file: "a plain file that matches no shipped base",
  edited_block: "a managed base block that was edited",
} as const;

function scrollBody(to: "top" | "bottom" | number) {
  const body = document.querySelector<HTMLElement>(`[data-pane-id="${RULES_PANE_ID}"] .pane-body`);
  if (!body) return;
  if (typeof to === "number") body.scrollBy?.({ top: to });
  else body.scrollTo?.({ top: to === "top" ? 0 : body.scrollHeight });
}

function shortDigest(digest: string | null): string {
  return digest ? digest.slice(0, 19) : "unknown";
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function DiffBody({ diff }: { diff: RulesDiffView }) {
  const edits = diff.mode === "edits";
  return (
    <>
      <p className="c-dim pane-note">
        {edits
          ? "What you changed: the closest shipped base against your file."
          : "What an update would do: your file against the current base."}
      </p>
      {diff.note && (
        <p className={diff.applicable ? "c-dim pane-note" : "c-warn pane-note"} role="status">
          {diff.note}
        </p>
      )}
      {diff.truncated && (
        <p className="c-warn pane-note" role="status">
          The diff is cut at 64 KB; the rest is not shown.
        </p>
      )}
      <DiffView
        diff={diff.diff}
        label={`${diff.from_label} to ${diff.to_label}`}
        empty={edits ? "no differences from the shipped base" : "no differences: nothing would change"}
      />
    </>
  );
}

function ConversionBody({ preview, view }: { preview: RulesConversionPreview; view: "diff" | "file" }) {
  if (!preview.applicable) {
    return (
      <div className="plan-state">
        <p className="rv-error" role="alert">
          <span className="rv-mark rv-mark-remove" aria-hidden="true" />
          nothing to convert: {preview.reason ?? "this file cannot be converted"}
        </p>
        <p className="c-dim">Nothing was written. A file the base block already manages updates through the regular update.</p>
      </div>
    );
  }
  const moved = preview.moved_sections;
  const removed = preview.removed_sections;
  const items: KvItem[] = [
    { label: "origin", value: preview.origin ? ORIGIN_TEXT[preview.origin] : "unknown", wrap: true },
    {
      label: "compared",
      value: `shipped base ${shortDigest(preview.compared_base)}${
        preview.compared_base_changed_lines === null ? "" : ` · ${preview.compared_base_changed_lines} changed lines`
      }`,
      wrap: true,
    },
    {
      label: "kept",
      value:
        moved.length === 0
          ? "nothing moves; text around the block stays where it is"
          : `${moved.length} section${moved.length === 1 ? "" : "s"} below the END marker: ${moved.join(", ")}`,
      tone: moved.length > 0 ? "ok" : "dim",
      wrap: true,
    },
    {
      label: "returns",
      value:
        removed.length === 0
          ? "no base sections were missing"
          : `${removed.length} base section${removed.length === 1 ? "" : "s"} your file lacked: ${removed.join(", ")}`,
      tone: removed.length > 0 ? "warn" : "dim",
      wrap: true,
    },
  ];
  return (
    <>
      <Kv items={items} aria-label="Conversion summary" />
      <div className="group pane-group">{view === "diff" ? "diff: installed → after conversion" : `resulting file · ${lineCount(preview.result)} lines`}</div>
      {view === "diff" ? (
        <>
          {preview.diff_truncated && (
            <p className="c-warn pane-note" role="status">
              The diff is cut at 64 KB; the resulting file is still written in full.
            </p>
          )}
          <DiffView diff={preview.diff} label="Diff: installed to after conversion" empty="no differences" />
        </>
      ) : (
        <pre className="rules-file" aria-label="Resulting file">
          {preview.result}
        </pre>
      )}
    </>
  );
}

/**
 * The rules review: a sub-state of the harness page in place of its four panes. It shows a read-only unified diff
 * of the rules file (`d`), or the preview of converting it onto the base block (`v`): the sections that move below
 * the END marker, the exact file apply writes, and the diff. Nothing is written until `y`.
 *
 * Keys (focus inside the pane): `y` apply (conversion preview only), `n`/Esc close, `t` switch the diff between your
 * edits and the update, `v` open the conversion from the diff, `f` switch the conversion between its diff and the
 * resulting file, `r` open the review again after an error, `j`/`k`/`g g`/`G` scroll. Enter never applies.
 */
export function RulesPane({ flow, busyLabel, backupRoot, canConvert, returnPaneId = "surfaces" }: RulesPaneProps) {
  const { state } = flow;
  const open = state.status !== "idle";
  useConfirmMode(open);
  useStatusContext(open ? "rules" : null);
  const [view, setView] = useState<"diff" | "file">("diff");

  // A new conversion preview starts on its diff.
  const previewKey = state.status === "conversion" ? state.preview.preview_token : null;
  useEffect(() => setView("diff"), [previewKey]);

  // Take focus when the review appears, unless the user already moved somewhere deliberate.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const pane = document.querySelector(`[data-pane-id="${RULES_PANE_ID}"]`);
    const free =
      !active || active === document.body || !active.isConnected || pane?.contains(active) === true || active.closest(".topline") !== null;
    if (free) focusPaneById(RULES_PANE_ID);
  }, [open, state.status]);

  // When the review closes the page's own panes come back; hand the keyboard to the pane the review was opened
  // from (where d, v and m live) instead of leaving it on the body.
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        if (!focusPaneById(returnPaneId)) focusDefaultPane();
      }
    },
    [returnPaneId],
  );

  const surface = state.status === "idle" ? null : state.surface;
  const title = surface ? surfaceTitle(surface) : "";
  const converting = state.status === "conversion" && state.preview.applicable;

  const applyState = (): boolean | string => {
    if (state.status === "applying") return "applying…";
    if (state.status !== "conversion") return false;
    if (!state.preview.applicable) return false;
    if (!state.preview.plan_fingerprint || !state.preview.preview_token) return "the preview has no token; open it again";
    if (busyLabel) return `${busyLabel} is running`;
    return true;
  };
  const closeState = (): boolean | string => (state.status === "applying" ? "applying; it cannot be cancelled" : open);
  const closeLabel = state.status === "diff" ? "close" : "cancel";

  // The confirm line's buttons run these two: the very bindings the keys fire.
  const applyAction: Binding = {
    id: "rules.apply",
    keys: "y",
    title: "Convert the rules file as previewed",
    hint: "apply",
    group: "Rules review",
    scope: "pane",
    paneId: RULES_PANE_ID,
    when: applyState,
    run: () => flow.apply(),
  };
  const closeAction: Binding = {
    id: "rules.close",
    keys: ["n", "Escape"],
    title: "Close the rules review",
    hint: closeLabel,
    group: "Rules review",
    scope: "pane",
    paneId: RULES_PANE_ID,
    when: closeState,
    run: () => flow.close(),
  };

  const actions: Binding[] = [
    applyAction,
    closeAction,
    {
      id: "rules.mode",
      keys: "t",
      title: "Switch the diff between your edits and the update",
      hint: state.status === "diff" && state.diff.mode === "edits" ? "update diff" : "edits diff",
      group: "Rules review",
      scope: "pane",
      paneId: RULES_PANE_ID,
      when: () => state.status === "diff",
      run: () => void flow.switchDiffMode(),
    },
    {
      id: "rules.convert",
      keys: "v",
      title: "Preview converting the file onto the base block",
      hint: "convert",
      group: "Rules review",
      scope: "pane",
      paneId: RULES_PANE_ID,
      when: () => state.status === "diff" && canConvert && !busyLabel,
      run: () => {
        if (surface) void flow.openConversion(surface);
      },
    },
    {
      id: "rules.view",
      keys: "f",
      title: "Switch between the diff and the resulting file",
      hint: view === "diff" ? "show file" : "show diff",
      group: "Rules review",
      scope: "pane",
      paneId: RULES_PANE_ID,
      when: () => converting,
      run: () => setView(current => (current === "diff" ? "file" : "diff")),
    },
    {
      id: "rules.retry",
      keys: "r",
      title: "Open the review again",
      hint: "again",
      group: "Rules review",
      scope: "pane",
      paneId: RULES_PANE_ID,
      when: () => state.status === "error",
      run: () => void flow.retry(),
    },
    { id: "rules.down", keys: ["j", "ArrowDown"], title: "Scroll down", group: "Rules review", scope: "pane", paneId: RULES_PANE_ID, repeat: true, run: () => scrollBody(60) },
    { id: "rules.up", keys: ["k", "ArrowUp"], title: "Scroll up", group: "Rules review", scope: "pane", paneId: RULES_PANE_ID, repeat: true, run: () => scrollBody(-60) },
    { id: "rules.top", keys: ["g g", "Home"], title: "Scroll to top", group: "Rules review", scope: "pane", paneId: RULES_PANE_ID, run: () => scrollBody("top") },
    { id: "rules.bottom", keys: ["G", "End"], title: "Scroll to bottom", group: "Rules review", scope: "pane", paneId: RULES_PANE_ID, run: () => scrollBody("bottom") },
    {
      // Escape closes from anywhere while the review is open, not only from inside the pane.
      id: "rules.close.escape",
      keys: "Escape",
      title: "Close the rules review",
      group: "Rules review",
      scope: "global",
      when: () => open && state.status !== "applying",
      run: () => flow.close(),
    },
  ];
  useKeymap(actions);

  const question =
    state.status === "loading"
      ? `computing the ${state.what === "diff" ? "diff" : "conversion preview"} for ${title}…`
      : state.status === "applying"
        ? "applying: backing up, then writing…"
        : state.status === "error"
          ? "nothing was written"
          : state.status === "conversion"
            ? state.preview.applicable
              ? `convert ${title}: write the file shown?`
              : "nothing to convert"
            : state.status === "diff"
              ? "read-only: nothing is written"
              : "";
  const noteBackup = state.status === "conversion" && state.preview.applicable;

  const meta =
    state.status === "diff" ? (
      <>
        {`${title} · diff · `}
        <span className="rv-added" title={`${state.diff.added} lines added`}>+{state.diff.added}</span>{" "}
        <span className="rv-removed" title={`${state.diff.removed} lines removed`}>−{state.diff.removed}</span>
      </>
    ) : state.status === "conversion" || state.status === "applying" ? (
      `${title} · convert`
    ) : surface ? (
      title
    ) : null;

  return (
    <Pane
      id={RULES_PANE_ID}
      title="Rules review"
      label="Rules review"
      variant="card"
      scrollable
      defaultFocus
      meta={meta}
      footer={
        <ReviewFooter question={question} backup={noteBackup && { root: backupRoot }}>
          <BindingButton binding={applyAction} apply />
          <BindingButton binding={closeAction} />
        </ReviewFooter>
      }
    >
      {state.status === "loading" && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">
            computing the {state.what === "diff" ? "diff" : "conversion preview"} for {title}…
          </span>
        </div>
      )}
      {state.status === "error" && (
        <div className="plan-state">
          <p className="rv-error" role="alert">
            <span className="rv-mark rv-mark-remove" aria-hidden="true" />
            {state.message}
          </p>
          <p className="c-dim">{ERROR_HINT[state.what]}</p>
        </div>
      )}
      {state.status === "diff" && <DiffBody diff={state.diff} />}
      {(state.status === "conversion" || state.status === "applying") && <ConversionBody preview={state.preview} view={view} />}
    </Pane>
  );
}
