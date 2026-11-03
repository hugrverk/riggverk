import { useEffect } from "react";
import { takeBundledTitle, type FileConflictFlow } from "../hooks/useFileConflictFlow";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { redactDiffText } from "../lib/redactTerminalOutput";
import { BindingButton } from "../ui/BindingButton";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import type {
  FileDiffEntry,
  FileDiffView,
  FileUnit,
  FileUnitState,
  TakeBundledUnit,
} from "../types";
import { DiffView } from "./DiffView";
import { ReviewFooter } from "./ReviewFooter";
import { ActivityLoader } from "./TerminalOutput";
import { plural } from "../lib/plural";

export const CONFLICT_PANE_ID = "conflicts";

export interface ConflictPaneProps {
  flow: FileConflictFlow;
  /** The units of the reviewed surface, to name the one under review. */
  units: readonly FileUnit[];
  /** Label of an unrelated workspace task that is running; applying waits for it. */
  busyLabel: string | null;
  /** Where backups are written, for the note under a take-bundled preview. */
  backupRoot?: string | null;
  /** The pane that takes the keyboard back when the review closes. Default `surfaces`. */
  returnPaneId?: string;
}

const ERROR_HINT = {
  // A diff is read inline under the files cell, so this review never shows its error; the flow's state type is shared.
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
 * The conflict review: a sub-state of the harness page in place of its cells. It shows the preview of taking the
 * bundled version of one skill or agent: the files that are replaced, where yours are backed up, and the diff.
 * Nothing is written until `y`. (The read-only diff and the choice to keep yours are the Compare fold-out and the
 * buttons of the files cell on the page.)
 *
 * Keys (focus inside the pane): `y` apply, `n`/Esc cancel, `r` the review again after an error, `j`/`k`/`g g`/`G`
 * scroll. Enter never applies.
 */
export function ConflictPane({ flow, units, busyLabel, backupRoot, returnPaneId = "surfaces" }: ConflictPaneProps) {
  const { state } = flow;
  const open = state.status !== "idle";

  // Take focus when the review appears, unless the user already moved somewhere deliberate.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const pane = document.querySelector(`[data-pane-id="${CONFLICT_PANE_ID}"]`);
    const free =
      !active || active === document.body || !active.isConnected || pane?.contains(active) === true || active.closest(".shell-chrome") !== null;
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

  const unitKey = state.status === "idle" ? null : state.unit;
  const unit = units.find(candidate => candidate.key === unitKey);
  const previewed = state.status === "bundled" || state.status === "applying" ? state.preview : null;
  const reviewed = previewed?.units.find(candidate => candidate.key === unitKey) ?? null;
  const name = reviewed?.name ?? unit?.name ?? "";

  const applyState = (): boolean | string => {
    if (state.status === "applying") return "applying…";
    if (state.status !== "bundled") return false;
    if (busyLabel) return `${busyLabel} is running`;
    return true;
  };
  const closeState = (): boolean | string => (state.status === "applying" ? "applying; it cannot be canceled" : open);

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
    hint: "cancel",
    group: "Conflict review",
    scope: "pane",
    paneId: CONFLICT_PANE_ID,
    when: closeState,
    run: () => flow.close(),
  };
  const actions: Binding[] = [
    applyAction,
    closeAction,
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

  const question =
    state.status === "loading"
      ? `computing the take-bundled preview for ${name || "the files"}…`
      : state.status === "applying"
        ? "applying: backing up, then writing…"
        : state.status === "error"
          ? "nothing was written"
          : state.status === "bundled"
            ? `replace your ${reviewed ? takeBundledTitle(reviewed) : name} with the bundled version? your files are backed up first`
            : "";
  const noteBackup = previewed !== null;

  const sums = (files: readonly FileDiffEntry[]) => files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const diffShown = reviewed?.diff ?? null;
  const totals = diffShown ? sums(diffShown.files) : null;
  const meta =
    diffShown && totals ? (
      <>
        {`${name} · ${diffShown.folder} · take bundled · `}
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
          <BindingButton binding={closeAction} />
        </ReviewFooter>
      }
    >
      {state.status === "loading" && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">
            computing the take-bundled preview for {name || "the files"}…
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
      {reviewed && <BundledBody reviewed={reviewed} unit={unit} />}
    </Pane>
  );
}
