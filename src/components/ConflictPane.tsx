import { useEffect } from "react";
import { takeBundledTitle, type FileConflictFlow } from "../hooks/useFileConflictFlow";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { NO_BUNDLED_COPY } from "../lib/fileConflicts";
import { redactDiffText } from "../lib/redactTerminalOutput";
import { useConfirmMode, useStatusContext } from "../shell/ShellState";
import { BindingButton } from "../ui/BindingActionKey";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import type {
  FileDiffEntry,
  FileDiffView,
  FilesSurfaceId,
  FileUnit,
  FileUnitState,
  TakeBundledUnit,
} from "../types";
import { DiffView } from "./DiffView";
import { ReviewFooter } from "./ReviewFooter";
import { ActivityLoader } from "./TerminalOutput";

export const CONFLICT_PANE_ID = "conflicts";

export interface ConflictPaneProps {
  flow: FileConflictFlow;
  /** The units of the reviewed surface, in list order: `[` and `]` move between them, `m` and `b` act on the open one. */
  units: readonly FileUnit[];
  /** Marks a unit on the page, so the review and the list agree on which one is current. */
  onMark: (key: string) => void;
  /** `m`: keep my version of a unit in conflict, or hand a kept one back. */
  onToggleKept: (surface: FilesSurfaceId, unit: FileUnit) => void;
  /** Label of an unrelated workspace task that is running; keeping, handing back and applying wait for it. */
  busyLabel: string | null;
  /** Where backups are written, for the note under a take-bundled preview. */
  backupRoot?: string | null;
  /** The pane that takes the keyboard back when the review closes. Default `surfaces`. */
  returnPaneId?: string;
}

const ERROR_HINT = {
  diff: "The diff could not be computed. Nothing was written.",
  bundled: "The take-bundled preview could not be computed. Nothing was written.",
  apply: "The backend refused this replacement before it ran. Nothing was written; preview again to review the files as they are now.",
} as const;

/** Most backup names the summary lists; the rest are counted. */
const LISTED_BACKUPS = 4;

function scrollBody(to: "top" | "bottom" | number) {
  const body = document.querySelector<HTMLElement>(`[data-pane-id="${CONFLICT_PANE_ID}"] .pane-body`);
  if (!body) return;
  if (typeof to === "number") body.scrollBy?.({ top: to });
  else body.scrollTo?.({ top: to === "top" ? 0 : body.scrollHeight });
}

function size(side: { bytes: number; digest: string } | null): string {
  return side ? `${side.bytes.toLocaleString("en-US")} bytes · ${side.digest}` : "not available";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function FileSection({ entry, state, layout }: { entry: FileDiffEntry; state: FileUnitState; layout: "unified" | "split" }) {
  const counts = entry.kind === "text" ? ` · +${entry.added} −${entry.removed}` : "";
  const items: KvItem[] = [
    { label: "yours", value: size(entry.installed) },
    { label: "bundled", value: size(entry.bundled) },
  ];
  return (
    <>
      <div className="group pane-group">
        {entry.rel}
        <span className="c-dim">{` · ${state === "kept" ? "you manage" : "conflict"}${counts}`}</span>
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
            <DiffView diff={redactDiffText(entry.diff)} label={`${entry.rel}: yours to bundled`} layout={layout} />
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

/** The files of one unit's diff, one section each; `split` is the side-by-side Compare of the harness page. */
export function FileSections({ diff, unit, layout = "unified" }: { diff: FileDiffView; unit: FileUnit | undefined; layout?: "unified" | "split" }) {
  return (
    <>
      {diff.files.map(entry => (
        // The list is read again after keeping or handing back; the diff itself is not, so the state comes from it.
        <FileSection key={entry.rel} entry={entry} state={unit?.files.find(file => file.rel === entry.rel)?.state ?? entry.state} layout={layout} />
      ))}
      {diff.more_files > 0 && (
        <p className="c-warn pane-note" role="status">
          {diff.more_files} more file{diff.more_files === 1 ? "" : "s"} of this unit not shown.
        </p>
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
      <FileSections diff={diff} unit={unit} />
    </>
  );
}

/** The summary and the diff of a take bundled: which files go, where yours are backed up, what changes. */
function BundledBody({ reviewed, unit }: { reviewed: TakeBundledUnit; unit: FileUnit | undefined }) {
  const total = reviewed.files.length + reviewed.more_files;
  const backups = reviewed.files.map(file => file.backup_name);
  const listed = backups.slice(0, LISTED_BACKUPS);
  const unlisted = backups.length - listed.length + reviewed.more_files;
  const keeps = reviewed.files.some(file => file.state === "kept");
  // A skill from a skill pack is replaced by the pack's file, not a bundled one.
  const source = reviewed.source ?? "bundled";
  const items: KvItem[] = [
    { label: "replaces", value: `${takeBundledTitle(reviewed)} · ${reviewed.folder}`, wrap: true },
    ...(reviewed.source ? [{ label: "source", value: reviewed.source }] : []),
    ...(unit && unit.kind === "skill" && unit.read_by.length > 0 ? [{ label: "read by", value: unit.read_by.join(", ") }] : []),
    {
      label: "backs up",
      value: `${plural(total, "file")}: ${listed.join(", ")}${unlisted > 0 ? ` +${unlisted} more` : ""}`,
      wrap: true,
    },
    {
      label: "leaves",
      value: "everything else: your other conflicts, files you keep and the rest of the install are not touched",
      tone: "dim",
      wrap: true,
    },
  ];
  return (
    <>
      <Kv items={items} aria-label="Take bundled summary" />
      {keeps && (
        <p className="c-warn pane-note" role="status">
          You keep your version now. After taking the {source === "bundled" ? "bundled" : "pack"} one Riggverk manages it again; rolling back restores your file but not that choice.
        </p>
      )}
      <p className="c-dim pane-note">What the replacement changes: your files (−) against the {source} ones (+).</p>
      <FileSections diff={reviewed.diff} unit={unit} />
    </>
  );
}

/**
 * The conflict review: a sub-state of the harness page in place of its two panes. It shows a read-only diff of
 * one skill or agent (all its conflicting or kept files) against the bundled files (`d`), or the preview of taking
 * the bundled version (`b`): the files that are replaced, where yours are backed up, and the diff. Nothing is
 * written until `y` on the take-bundled preview, apart from the choice itself: `m` keeps your version, or hands a
 * kept one back, and asks first.
 *
 * Keys (focus inside the pane): `y` apply (take-bundled preview only), `b` take bundled (from the diff), `m` keep
 * mine / hand back (from the diff), `[` and `]` the previous and next unit, `n`/Esc close, `r` the review again
 * after an error, `j`/`k`/`g g`/`G` scroll. Enter never applies.
 */
export function ConflictPane({ flow, units, onMark, onToggleKept, busyLabel, backupRoot, returnPaneId = "surfaces" }: ConflictPaneProps) {
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
  // from (where c, d, b and m live) instead of leaving it on the body.
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
  const unitKey = state.status === "idle" ? null : state.unit;
  const unit = units.find(candidate => candidate.key === unitKey);
  const previewed = state.status === "bundled" || state.status === "applying" ? state.preview : null;
  const reviewed = previewed?.units.find(candidate => candidate.key === unitKey) ?? null;
  const name = state.status === "diff" ? state.diff.name : (reviewed?.name ?? unit?.name ?? "");
  const index = unit ? units.indexOf(unit) : -1;
  const taking = previewed !== null;

  const move = (step: number) => {
    if (!surface || units.length < 2 || index < 0) return;
    const next = units[(index + step + units.length) % units.length]!;
    onMark(next.key);
    void flow.openDiff(surface, next.key);
  };

  const applyState = (): boolean | string => {
    if (state.status === "applying") return "applying…";
    if (state.status !== "bundled") return false;
    if (busyLabel) return `${busyLabel} is running`;
    return true;
  };
  const closeState = (): boolean | string => (state.status === "applying" ? "applying; it cannot be cancelled" : open);
  const closeLabel = taking ? "cancel" : "close";

  // The confirm line's buttons run these: the very bindings the keys fire.
  const applyAction: Binding = {
    id: "conflicts.apply",
    keys: "y",
    title: "Replace the files by the bundled ones as previewed; yours are backed up first",
    hint: "apply",
    group: "Conflict review",
    scope: "pane",
    paneId: CONFLICT_PANE_ID,
    when: applyState,
    run: () => flow.apply(),
  };
  const closeAction: Binding = {
    id: "conflicts.close",
    keys: ["n", "Escape"],
    title: "Close the conflict review",
    hint: closeLabel,
    group: "Conflict review",
    scope: "pane",
    paneId: CONFLICT_PANE_ID,
    when: closeState,
    run: () => flow.close(),
  };
  const bundledAction: Binding = {
    id: "conflicts.bundled",
    keys: "b",
    title: "Preview replacing the skill or agent by the bundled version",
    hint: "take bundled",
    group: "Conflict review",
    scope: "pane",
    paneId: CONFLICT_PANE_ID,
    when: () => (state.status !== "diff" || !unit ? false : !unit.wanted ? NO_BUNDLED_COPY : busyLabel ? `${busyLabel} is running` : true),
    run: () => {
      if (surface && unit) void flow.openBundled(surface, unit.key);
    },
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

  const moves = state.status === "diff" || state.status === "error";
  const actions: Binding[] = [
    applyAction,
    bundledAction,
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
      when: () => units.length > 1 && index >= 0 && moves,
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
      when: () => units.length > 1 && index >= 0 && moves,
      run: () => move(1),
    },
    {
      id: "conflicts.retry",
      keys: "r",
      title: "Open the review again",
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
      when: () => open && state.status !== "applying",
      run: () => flow.close(),
    },
  ];
  useKeymap(actions);

  const what = state.status === "loading" ? (state.what === "bundled" ? "the take-bundled preview" : "the diff") : "";
  const question =
    state.status === "loading"
      ? `computing ${what} for ${name || "the files"}…`
      : state.status === "applying"
        ? "applying: backing up, then writing…"
        : state.status === "error"
          ? "nothing was written"
          : state.status === "bundled"
            ? `replace your ${reviewed ? takeBundledTitle(reviewed) : name} with the bundled version? your files are backed up first`
            : state.status === "diff"
              ? "read-only: nothing is written"
              : "";
  const noteBackup = taking;

  const sums = (files: readonly FileDiffEntry[]) => files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const diffShown = state.status === "diff" ? state.diff : (reviewed?.diff ?? null);
  const totals = diffShown ? sums(diffShown.files) : null;
  const meta =
    diffShown && totals ? (
      <>
        {`${name} · ${diffShown.folder} · ${taking ? "take bundled" : "diff"} · `}
        <span className="rv-added" title={`${totals.added} lines added`}>+{totals.added}</span>{" "}
        <span className="rv-removed" title={`${totals.removed} lines removed`}>−{totals.removed}</span>
      </>
    ) : name ? (
      name
    ) : null;

  return (
    <Pane
      id={CONFLICT_PANE_ID}
      title="Conflict review"
      label="Conflict review"
      variant="card"
      scrollable
      defaultFocus
      meta={meta}
      footer={
        <ReviewFooter question={question} backup={noteBackup && { root: backupRoot }}>
          <BindingButton binding={applyAction} apply />
          <BindingButton binding={keepAction} />
          <BindingButton binding={bundledAction} />
          <BindingButton binding={closeAction} />
        </ReviewFooter>
      }
    >
      {state.status === "loading" && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">
            computing {what} for {name || "the files"}…
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
      {state.status === "diff" && <DiffBody diff={state.diff} unit={unit} />}
      {reviewed && <BundledBody reviewed={reviewed} unit={unit} />}
    </Pane>
  );
}
