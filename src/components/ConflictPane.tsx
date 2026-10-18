import { useEffect } from "react";
import type { FileConflictFlow } from "../hooks/useFileConflictFlow";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { redactDiffText } from "../lib/redactTerminalOutput";
import { useConfirmMode, useStatusContext } from "../shell/ShellState";
import { BindingButton } from "../ui/BindingActionKey";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import type { FileDiffEntry, FileDiffView, FilesSurfaceId, FileUnit, FileUnitState } from "../types";
import { DiffView } from "./DiffView";
import { ActivityLoader } from "./TerminalOutput";

export const CONFLICT_PANE_ID = "conflicts";

export interface ConflictPaneProps {
  flow: FileConflictFlow;
  /** The units of the reviewed surface, in list order: `[` and `]` move between them, `m` acts on the open one. */
  units: readonly FileUnit[];
  /** Marks a unit on the page, so the review and the list agree on which one is current. */
  onMark: (key: string) => void;
  /** `m`: keep my version of a unit in conflict, or hand a kept one back. */
  onToggleKept: (surface: FilesSurfaceId, unit: FileUnit) => void;
  /** Label of an unrelated workspace task that is running; keeping and handing back wait for it. */
  busyLabel: string | null;
  /** The pane that takes the keyboard back when the review closes. Default `surfaces`. */
  returnPaneId?: string;
}

function scrollBody(to: "top" | "bottom" | number) {
  const body = document.querySelector<HTMLElement>(`[data-pane-id="${CONFLICT_PANE_ID}"] .pane-body`);
  if (!body) return;
  if (typeof to === "number") body.scrollBy?.({ top: to });
  else body.scrollTo?.({ top: to === "top" ? 0 : body.scrollHeight });
}

function size(side: { bytes: number; digest: string } | null): string {
  return side ? `${side.bytes.toLocaleString("en-US")} bytes · ${side.digest}` : "not available";
}

function FileSection({ entry, state }: { entry: FileDiffEntry; state: FileUnitState }) {
  const counts = entry.kind === "text" ? ` · +${entry.added} −${entry.removed}` : "";
  const items: KvItem[] = [
    { label: "yours", value: size(entry.installed) },
    { label: "bundled", value: size(entry.bundled) },
  ];
  return (
    <>
      <div className="group pane-group">
        {entry.rel}
        <span className={state === "kept" ? "c-warn" : "c-dim"}>{` · ${state === "kept" ? "you manage" : "conflict"}${counts}`}</span>
      </div>
      {entry.kind === "text" ? (
        <>
          {entry.truncated && (
            <p className="c-warn pane-note" role="status">
              {entry.note ?? "The diff of this file is cut at 64 KB; the rest is not shown."}
            </p>
          )}
          {/* The backend withholds key blocks; the rest is masked here before it reaches the screen. */}
          {entry.diff === "" && entry.truncated ? null : (
            <DiffView diff={redactDiffText(entry.diff)} label={`${entry.rel}: yours to bundled`} />
          )}
        </>
      ) : (
        <>
          {entry.note && (
            <p className={entry.kind === "identical_text" ? "c-dim pane-note" : "c-warn pane-note"} role="status">
              {entry.note}
            </p>
          )}
          {entry.kind !== "unreadable" && <Kv items={items} aria-label={`${entry.rel} sizes`} />}
        </>
      )}
    </>
  );
}

function DiffBody({ diff, unit }: { diff: FileDiffView; unit: FileUnit | undefined }) {
  return (
    <>
      <p className="c-dim pane-note">Your files (−) against the bundled ones (+). Nothing is written.</p>
      {unit?.state === "kept" && (
        <p className="c-dim pane-note">
          You keep your version: updates never write it
          {unit.wanted ? (unit.bundle_changed ? "; the bundled file changed since you kept it." : "; the bundled file is unchanged since you kept it.") : "."}
        </p>
      )}
      {diff.files.map(entry => (
        // The list is read again after keeping or handing back; the diff itself is not, so the state comes from it.
        <FileSection key={entry.rel} entry={entry} state={unit?.files.find(file => file.rel === entry.rel)?.state ?? entry.state} />
      ))}
      {diff.more_files > 0 && (
        <p className="c-warn pane-note" role="status">
          {diff.more_files} more file{diff.more_files === 1 ? "" : "s"} of this unit not shown.
        </p>
      )}
    </>
  );
}

/**
 * The conflict review: a sub-state of the harness page in place of its two panes. It shows a read-only diff of
 * one skill or agent (all its conflicting or kept files) against the bundled files. Nothing is ever written by it
 * apart from the choice itself: `m` keeps your version, or hands a kept one back, and asks first.
 *
 * Keys (focus inside the pane): `m` keep mine / hand back, `[` and `]` the previous and next unit, `n`/Esc close,
 * `r` the diff again after an error, `j`/`k`/`g g`/`G` scroll.
 */
export function ConflictPane({ flow, units, onMark, onToggleKept, busyLabel, returnPaneId = "surfaces" }: ConflictPaneProps) {
  const { state } = flow;
  const open = state.status !== "idle";
  useConfirmMode(open);
  useStatusContext(open ? "conflicts" : null);

  // Take focus when the review appears, unless the user already moved somewhere deliberate.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const pane = document.querySelector(`[data-pane-id="${CONFLICT_PANE_ID}"]`);
    const free =
      !active || active === document.body || !active.isConnected || pane?.contains(active) === true || active.closest(".topline") !== null;
    if (free) focusPaneById(CONFLICT_PANE_ID);
  }, [open, state.status]);

  // When the review closes the page's own panes come back; hand the keyboard to the pane the review was opened
  // from (where c, d and m live) instead of leaving it on the body.
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
  const unit = state.status === "idle" ? undefined : units.find(candidate => candidate.key === state.unit);
  const name = state.status === "diff" ? state.diff.name : (unit?.name ?? "");
  const index = unit ? units.indexOf(unit) : -1;

  const move = (step: number) => {
    if (!surface || units.length < 2 || index < 0) return;
    const next = units[(index + step + units.length) % units.length]!;
    onMark(next.key);
    void flow.openDiff(surface, next.key);
  };

  const closeAction: Binding = {
    id: "conflicts.close",
    keys: ["n", "Escape"],
    title: "Close the conflict review",
    hint: "close",
    group: "Conflict review",
    scope: "pane",
    paneId: CONFLICT_PANE_ID,
    when: () => open,
    run: () => flow.close(),
  };
  const keepAction: Binding = {
    id: "conflicts.keep",
    keys: "m",
    title: unit?.state === "kept" ? "Hand the skill or agent back to the app" : "Keep my version of the skill or agent",
    hint: unit?.state === "kept" ? "hand back" : "keep mine",
    group: "Conflict review",
    scope: "pane",
    paneId: CONFLICT_PANE_ID,
    when: () => (state.status !== "diff" || !unit ? false : busyLabel ? `${busyLabel} is running` : true),
    run: () => {
      if (surface && unit) onToggleKept(surface, unit);
    },
  };

  const actions: Binding[] = [
    keepAction,
    closeAction,
    {
      id: "conflicts.previous",
      keys: "[",
      title: "Show the previous skill or agent",
      hint: "previous",
      group: "Conflict review",
      scope: "pane",
      paneId: CONFLICT_PANE_ID,
      when: () => units.length > 1 && index >= 0 && state.status !== "loading",
      run: () => move(-1),
    },
    {
      id: "conflicts.next",
      keys: "]",
      title: "Show the next skill or agent",
      hint: "next",
      group: "Conflict review",
      scope: "pane",
      paneId: CONFLICT_PANE_ID,
      when: () => units.length > 1 && index >= 0 && state.status !== "loading",
      run: () => move(1),
    },
    {
      id: "conflicts.retry",
      keys: "r",
      title: "Compute the diff again",
      hint: "again",
      group: "Conflict review",
      scope: "pane",
      paneId: CONFLICT_PANE_ID,
      when: () => state.status === "error",
      run: () => void flow.retry(),
    },
    { id: "conflicts.down", keys: ["j", "ArrowDown"], title: "Scroll down", group: "Conflict review", scope: "pane", paneId: CONFLICT_PANE_ID, repeat: true, run: () => scrollBody(60) },
    { id: "conflicts.up", keys: ["k", "ArrowUp"], title: "Scroll up", group: "Conflict review", scope: "pane", paneId: CONFLICT_PANE_ID, repeat: true, run: () => scrollBody(-60) },
    { id: "conflicts.top", keys: ["g g", "Home"], title: "Scroll to top", group: "Conflict review", scope: "pane", paneId: CONFLICT_PANE_ID, run: () => scrollBody("top") },
    { id: "conflicts.bottom", keys: ["G", "End"], title: "Scroll to bottom", group: "Conflict review", scope: "pane", paneId: CONFLICT_PANE_ID, run: () => scrollBody("bottom") },
    {
      // Escape closes from anywhere while the review is open, not only from inside the pane.
      id: "conflicts.close.escape",
      keys: "Escape",
      title: "Close the conflict review",
      group: "Conflict review",
      scope: "global",
      when: () => open,
      run: () => flow.close(),
    },
  ];
  useKeymap(actions);

  const question =
    state.status === "loading"
      ? `computing the diff for ${name || "the files"}…`
      : state.status === "error"
        ? "nothing was written"
        : state.status === "diff"
          ? "read-only: nothing is written"
          : "";

  const totals = state.status === "diff" ? state.diff.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }) : null;
  const meta =
    state.status === "diff" && totals ? (
      <>
        {`· ${name} · ${state.diff.folder} · diff · `}
        <span className="c-ok" title={`${totals.added} lines added`}>+{totals.added}</span>{" "}
        <span className="c-fail" title={`${totals.removed} lines removed`}>−{totals.removed}</span>
      </>
    ) : name ? (
      `· ${name}`
    ) : null;

  return (
    <Pane
      id={CONFLICT_PANE_ID}
      title="conflicts"
      label="Conflict review"
      scrollable
      defaultFocus
      meta={meta}
      footer={
        <>
          <span className="q" role="status">
            {question}
          </span>
          <span className="tbtn-row">
            <BindingButton binding={keepAction} variant="primary" />
            <BindingButton binding={closeAction} />
          </span>
        </>
      }
    >
      {state.status === "loading" && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">computing the diff for {name || "the files"}…</span>
        </div>
      )}
      {state.status === "error" && (
        <div className="plan-state">
          <p className="c-fail" role="alert">
            <Glyph name="fail" tone="fail" /> {state.message}
          </p>
          <p className="c-dim">The diff could not be computed. Nothing was written.</p>
        </div>
      )}
      {state.status === "diff" && <DiffBody diff={state.diff} unit={unit} />}
    </Pane>
  );
}
