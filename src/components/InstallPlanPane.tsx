import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { InstallFlow, InstallFlowErrorKind } from "../hooks/useInstallFlow";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { displayPath } from "../lib/displayPath";
import {
  buildPlanGroups,
  countPlanRows,
  describePlanCounts,
  planRows,
  type PlanCounts,
} from "../lib/installPlan";
import { useConfirmMode, useStatusContext } from "../shell/ShellState";
import { BindingButton } from "../ui/BindingActionKey";
import { Glyph } from "../ui/Glyph";
import { Pane } from "../ui/Pane";
import { cx, toneClass } from "../ui/tone";
import { ActivityLoader } from "./TerminalOutput";

export const INSTALL_PLAN_PANE_ID = "plan";

export interface InstallPlanPaneProps {
  flow: InstallFlow;
  /** Label of an unrelated workspace task that is running; apply waits for it. */
  busyLabel: string | null;
  /** Where backups are written, for the note under the table. */
  backupRoot?: string | null;
  /** Applies the reviewed plan (the owner runs it through the workspace task runner). */
  onApply: () => void;
}

const ERROR_HINT: Record<InstallFlowErrorKind, string> = {
  no_surfaces: "Every surface of this target is switched off. Turn a target on, then try again.",
  preview_failed: "The preview could not be computed. Nothing was written.",
  stale: "Installed files changed after this preview. Nothing was written; preview again to review the new plan.",
  expired: "This preview expired or was already used. Nothing was written; preview again.",
  apply_failed: "The backend refused to apply this plan before it ran. Nothing was written.",
};

function Counts({ counts }: { counts: PlanCounts }) {
  return (
    <>
      {counts.create > 0 && <span className="c-ok" title={`${counts.create} to create`}>+{counts.create}</span>}
      {counts.update > 0 && <span className="c-warn" title={`${counts.update} to update`}>{" "}~{counts.update}</span>}
      {counts.remove > 0 && <span className="c-fail" title={`${counts.remove} to remove`}>{" "}−{counts.remove}</span>}
      {counts.conflict > 0 && <span className="c-fail" title={`${counts.conflict} conflicts`}>{" "}!{counts.conflict}</span>}
      {counts.unchanged > 0 && <span className="c-dim" title={`${counts.unchanged} surfaces unchanged`}>{" "}={counts.unchanged}</span>}
    </>
  );
}

/**
 * The install review: a sub-state of the Start and harness pages. Lists what apply would write, grouped by
 * surface, with `+ ~ − !` glyphs and a text label on every row, and asks before anything is written.
 *
 * Keys (focus inside the pane): `j`/`k` move, `d` details of the row, `c` next conflict, `y` apply (review
 * only, and only when there is something safe to apply), `n`/Esc cancel, `r` preview again after a stale or
 * expired preview. Enter never applies; the `y apply` hint in the status bar is clickable and does the same as the key.
 */
export function InstallPlanPane({ flow, busyLabel, backupRoot, onApply }: InstallPlanPaneProps) {
  const { status, review, error, request } = flow;
  const open = status !== "idle";
  useConfirmMode(open);
  useStatusContext(open ? "plan" : null);

  const tableRef = useRef<HTMLTableElement>(null);
  const tableId = useId();
  const groups = useMemo(() => (review ? buildPlanGroups(review) : []), [review]);
  const rows = useMemo(() => planRows(groups), [groups]);
  const counts = useMemo(() => countPlanRows(groups), [groups]);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const plan = review?.plan;
  useEffect(() => {
    setCursor(0);
    setExpanded(new Set());
  }, [plan]);

  // Take focus when the review (or its error) appears, unless the user already moved somewhere deliberate.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const pane = document.querySelector(`[data-pane-id="${INSTALL_PLAN_PANE_ID}"]`);
    const free =
      !active || active === document.body || !active.isConnected || pane?.contains(active) === true || active.closest(".topline") !== null;
    if (free) focusPaneById(INSTALL_PLAN_PANE_ID);
  }, [open, status]);

  // When the review closes the page's own panes come back; hand them the keyboard instead of leaving it on the body.
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) focusDefaultPane();
    },
    [],
  );

  const at = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1);
  const rowDomId = (rowId: string) => `${tableId}-${rowId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const activeRow = at >= 0 ? rows[at] : undefined;

  const readOnly = request?.readOnly === true;
  const reviewing = status === "review" && review !== null;
  const hasTable = (status === "review" || status === "applying") && review !== null;
  const describe = describePlanCounts(counts);
  const question =
    status === "previewing"
      ? `previewing ${request?.label ?? ""}…`
      : status === "applying"
        ? "applying: backing up, then writing…"
        : status === "error"
          ? "nothing was written"
          : readOnly
            ? `preview only: ${describe.startsWith("apply ") ? `would ${describe}` : describe}`
            : review?.canApply
              ? `${describe}?`
              : describe;

  const moveTo = (next: number) => {
    if (rows.length === 0) return;
    const clamped = Math.min(rows.length - 1, Math.max(0, next));
    setCursor(clamped);
    const id = rows[clamped]!.id;
    document.getElementById(rowDomId(id))?.scrollIntoView?.({ block: "nearest" });
  };

  const cancelState = (): boolean | string => {
    if (status === "applying") return "applying; it cannot be cancelled";
    return open;
  };

  const applyState = (): boolean | string => {
    if (status === "applying") return "applying…";
    if (!reviewing || readOnly) return false;
    if (!review.canApply) return describe;
    if (busyLabel) return `${busyLabel} is running`;
    return true;
  };

  // The confirm line's buttons run these two: the very bindings the keys fire.
  const applyAction: Binding = {
    id: "plan.apply",
    keys: "y",
    title: "Apply the reviewed plan",
    hint: "apply",
    group: "Install plan",
    scope: "pane",
    paneId: INSTALL_PLAN_PANE_ID,
    when: applyState,
    run: () => onApply(),
  };
  const cancelAction: Binding = {
    id: "plan.cancel",
    keys: ["n", "Escape"],
    title: readOnly ? "Close the preview" : "Cancel the review",
    hint: readOnly ? "close" : "cancel",
    group: "Install plan",
    scope: "pane",
    paneId: INSTALL_PLAN_PANE_ID,
    when: cancelState,
    run: () => flow.cancel(),
  };

  const actions: Binding[] = [
    applyAction,
    cancelAction,
    {
      id: "plan.details",
      keys: "d",
      title: "Show or hide details of the row",
      hint: "details",
      group: "Install plan",
      scope: "pane",
      paneId: INSTALL_PLAN_PANE_ID,
      when: () => reviewing && rows.length > 0,
      run: () => {
        if (!activeRow) return;
        setExpanded(current => {
          const next = new Set(current);
          if (!next.delete(activeRow.id)) next.add(activeRow.id);
          return next;
        });
      },
    },
    {
      id: "plan.conflict",
      keys: "c",
      title: "Jump to the next conflict",
      hint: "next conflict",
      group: "Install plan",
      scope: "pane",
      paneId: INSTALL_PLAN_PANE_ID,
      when: () => reviewing && counts.conflict > 0,
      run: () => {
        const ordered = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
        const next = ordered.find(row => row.conflict);
        if (next) moveTo(rows.indexOf(next));
      },
    },
    {
      id: "plan.repreview",
      keys: "r",
      title: "Preview again",
      hint: "preview again",
      group: "Install plan",
      scope: "pane",
      paneId: INSTALL_PLAN_PANE_ID,
      when: () => status === "error" && error?.canRepreview === true,
      run: () => void flow.repreview(),
    },
    {
      // Escape cancels from anywhere while the review is open, not only from inside the pane.
      id: "plan.cancel.escape",
      keys: "Escape",
      title: readOnly ? "Close the preview" : "Cancel the review",
      group: "Install plan",
      scope: "global",
      when: () => status !== "applying" && open,
      run: () => flow.cancel(),
    },
  ];
  useKeymap(actions);

  const navigation: Binding[] = [
    { id: "plan.next", keys: ["j", "ArrowDown"], title: "Next row", group: "Install plan", scope: "list", repeat: true, run: () => moveTo(at + 1) },
    { id: "plan.prev", keys: ["k", "ArrowUp"], title: "Previous row", group: "Install plan", scope: "list", repeat: true, run: () => moveTo(at - 1) },
    { id: "plan.first", keys: ["g g", "Home"], title: "First row", group: "Install plan", scope: "list", run: () => moveTo(0) },
    { id: "plan.last", keys: ["G", "End"], title: "Last row", group: "Install plan", scope: "list", run: () => moveTo(rows.length - 1) },
  ];
  useKeymap(navigation, { ref: tableRef, enabled: hasTable });

  const noteBackup = reviewing && !readOnly && review.canApply;
  const footer = (
    <>
      <span className="q" role="status">
        {question}
      </span>
      <span className="tbtn-row">
        <BindingButton binding={applyAction} variant="primary" />
        <BindingButton binding={cancelAction} />
      </span>
      {noteBackup && (
        <span className="bk">
          backup → {backupRoot ? `${displayPath(backupRoot)}/` : ""}&lt;run&gt; · transaction recorded · rollback available
        </span>
      )}
    </>
  );

  return (
    <Pane
      id={INSTALL_PLAN_PANE_ID}
      title="plan"
      label="Install plan"
      scrollable={!hasTable}
      defaultFocus
      meta={
        request ? (
          <>
            {"· "}
            {request.label}
            {reviewing && (
              <>
                {` · ${groups.length} surface${groups.length === 1 ? "" : "s"} · `}
                <Counts counts={counts} />
              </>
            )}
            {status === "previewing" && " · previewing"}
            {status === "error" && <span className="c-fail"> · failed</span>}
          </>
        ) : null
      }
      footer={footer}
    >
      {status === "previewing" && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">computing the plan for {request?.label}…</span>
        </div>
      )}

      {status === "error" && error && (
        <div className="plan-state">
          <p className="c-fail" role="alert">
            <Glyph name="fail" tone="fail" /> {error.message}
          </p>
          <p className="c-dim">{ERROR_HINT[error.kind]}</p>
        </div>
      )}

      {hasTable && (
        <table
          ref={tableRef}
          className="plan"
          role="grid"
          aria-label="Install plan"
          aria-activedescendant={activeRow ? rowDomId(activeRow.id) : undefined}
          tabIndex={0}
          data-pane-primary=""
        >
          <thead>
            <tr>
              <th scope="col"><span className="visually-hidden">cursor</span></th>
              <th scope="col">op</th>
              <th scope="col">file</th>
              <th scope="col">why</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(group => (
              <Fragment key={group.surface}>
                <tr className="g">
                  <td colSpan={4}>
                    {group.title}
                    {group.unchanged ? " · unchanged" : ""}
                  </td>
                </tr>
                {group.rows.map(row => {
                  const isCursor = activeRow?.id === row.id;
                  const isOpen = expanded.has(row.id);
                  return (
                    <Fragment key={row.id}>
                      <tr
                        id={rowDomId(row.id)}
                        className={cx(row.conflict && "conf")}
                        aria-selected={isCursor}
                        aria-expanded={isOpen}
                        onClick={() => {
                          tableRef.current?.focus();
                          setCursor(rows.indexOf(row));
                        }}
                      >
                        <td className="c-acc">
                          <span className="g" aria-hidden="true">{isCursor ? "▸" : " "}</span>
                        </td>
                        <td className={cx("op", toneClass(row.tone))}>
                          <Glyph name={row.glyph} /> {row.label}
                        </td>
                        <td title={row.file}>{row.file}</td>
                        <td className="note" title={row.note}>
                          {row.conflict && (
                            <>
                              <span className="c-head">preserved, skipped</span>
                              {row.note ? " · " : ""}
                            </>
                          )}
                          {row.note}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="detail">
                          <td />
                          <td colSpan={3}>
                            {row.detail.map(line => (
                              <div key={line}>{line}</div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td />
                <td colSpan={3} className="c-dim">
                  nothing to change: every requested surface is current
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Pane>
  );
}
