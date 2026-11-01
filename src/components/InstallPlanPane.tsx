import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { InstallFlow, InstallFlowErrorKind } from "../hooks/useInstallFlow";
import type { InstallDone } from "../hooks/useInstallScreen";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import type { FlowModel, RunTrace } from "../lib/flowModel";
import { HARNESS_LABELS } from "../lib/harnessInstallation";
import {
  backupSentence,
  buildAgentPlan,
  buildPlanGroups,
  countPlanRows,
  describePlanCounts,
  installReviewLabel,
  planFileCount,
  planRowAgent,
  summaryTiles,
  type AgentPlanGroup,
  type PlanAgentId,
  type PlanCounts,
  type PlanRow,
} from "../lib/installPlan";
import { buildPlanFlow, type PlanCurve, type PlanPhase } from "../lib/planFlow";
import { plural } from "../lib/plural";
import { formatCheckedAt } from "../shell/Sidebar";
import type { ApplyProgress, InstallAgent } from "../types";
import { AgentIcon } from "../ui/agentIcons";
import { BindingButton } from "../ui/BindingButton";
import { Pane } from "../ui/Pane";
import { RuneMark } from "../ui/RuneMark";
import { StatePill } from "../ui/StatePill";
import { TButton } from "../ui/TButton";
import { cx } from "../ui/tone";
import { PlanFlowMap } from "./PlanFlowMap";
import { ReviewFooter } from "./ReviewFooter";
import { Receipt } from "./run/Receipt";
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
  /** The apply that just succeeded: the card shows its done state instead of closing. */
  done?: InstallDone | null;
  /** Closes the done state (`n`, Esc, Dismiss). */
  onDismiss?: () => void;
  /** Undo the transaction the apply left (the dry run and the confirm happen in the owner). */
  onUndo?: (transactionId: string) => void;
  /** What the backend last reported for the apply in flight. */
  progress?: ApplyProgress | null;
  /** Which agent the apply is writing, read from the files it reports (`useRunTrace`). */
  trace?: RunTrace | null;
  /** The Overview's flow model: the map's sources, the agents that are on and those that are off. */
  flowBase?: FlowModel | null;
  /** "Open <Agent> →" beside a conflict: the agent's page, where it is resolved. */
  onOpenAgent?: (agent: InstallAgent) => void;
}

const ERROR_HINT: Record<InstallFlowErrorKind, string> = {
  no_surfaces: "Every surface of this target is switched off. Turn a target on, then try again.",
  preview_failed: "The preview could not be computed. Nothing was written.",
  stale: "Installed files changed after this preview. Nothing was written; preview again to review the new plan.",
  expired: "This preview expired or was already used. Nothing was written; preview again.",
  apply_failed: "The backend refused to apply this plan before it ran. Nothing was written.",
};

const DONE_WORD: Partial<Record<PlanRow["kind"], string>> = { create: "created", update: "updated", remove: "removed" };

/** The title's tally in words: `1 create · 2 update · 1 conflict`. A conflict is the decision, so it is set heavier. */
function Counts({ counts }: { counts: PlanCounts }) {
  const parts: Array<{ kind: string; text: string }> = [];
  if (counts.create > 0) parts.push({ kind: "create", text: `${counts.create} create` });
  if (counts.update > 0) parts.push({ kind: "update", text: `${counts.update} update` });
  if (counts.remove > 0) parts.push({ kind: "remove", text: `${counts.remove} remove` });
  if (counts.conflict > 0) parts.push({ kind: "conflict", text: `${counts.conflict} ${counts.conflict === 1 ? "conflict" : "conflicts"}` });
  if (counts.unchanged > 0) parts.push({ kind: "unchanged", text: `${counts.unchanged} unchanged` });
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.kind}>
          {index > 0 && " · "}
          <span className={`rv-count rv-count-${part.kind}`}>{part.text}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The summary band: a proportional bar of the kinds, one count tile per kind (the conflict tile the one filled mark),
 * and what applying amounts to. The bar is decoration; the tiles say every number in words.
 */
function SummaryBand({ counts, rows, phase }: { counts: PlanCounts; rows: readonly PlanRow[]; phase: PlanPhase }) {
  const tiles = summaryTiles(counts);
  const safe = counts.create + counts.update + counts.remove;
  const files = planFileCount(rows);
  return (
    <div className="plan-band">
      <div className="plan-bar" aria-hidden="true">
        {tiles
          .filter(tile => tile.n > 0)
          .map(tile => (
            <i key={tile.kind} className={`is-${tile.kind}`} style={{ flexGrow: tile.n }} />
          ))}
      </div>
      <ul className="plan-tiles" aria-label="Changes by kind">
        {tiles.map(tile => (
          <li key={tile.kind} className={cx("plan-tile", `is-${tile.kind}`, tile.n === 0 && "is-zero")}>
            <b>{tile.n}</b>
            <span className="plan-tile-k">
              <span className={`rv-mark rv-mark-${tile.kind === "unchanged" ? "unavailable" : tile.kind}`} aria-hidden="true" />
              {tile.label}
            </span>
            <span className="plan-tile-s">{tile.sub}</span>
          </li>
        ))}
      </ul>
      <p className="plan-ask">
        <b>
          {phase === "done" ? `${plural(safe, "change")} applied` : plural(safe, "safe change")} · {plural(files, "file")}
        </b>
        <span>{phase === "done" ? "Undo puts the backed-up files back and removes the new ones" : backupSentence(rows)}</span>
      </p>
    </div>
  );
}

/** Under the map while the apply runs: the phase, the agent being written and the files counted so far. */
function PlanProgress({ progress, agent }: { progress: ApplyProgress | null | undefined; agent: string | null }) {
  const total = progress?.total ?? null;
  const done = progress?.done ?? 0;
  const ratio = total ? Math.min(1, Math.max(0, done / total)) : 0;
  const backup = progress?.phase === "backup";
  return (
    <div className="plan-progress">
      <p>
        <b>{backup ? "Backing up" : progress ? "Backed up" : "Starting"}</b>
        {!backup && progress && <> · writing {agent ?? "files"}</>}
      </p>
      <span className="plan-track" aria-hidden="true">
        <i style={{ "--p": `${Math.round(ratio * 100)}%` } as CSSProperties} />
      </span>
      <p className="c-dim">
        {total !== null ? `${done} of ${plural(total, "file")}` : "counting files…"} · one transaction, rolled back together on failure
      </p>
    </div>
  );
}

/**
 * Under the map once the apply succeeded: the verdict and the run's receipt. A successful run can still leave steps to
 * the user (a manual step of the plan, a warning the backend returned with it): then it never reads as all clear, and
 * each step is listed.
 */
function DoneReceipt({ done, counts, agents }: { done: InstallDone; counts: PlanCounts; agents: string[] }) {
  const { result } = done;
  const written = counts.create + counts.update + counts.remove;
  const steps = result.manual_steps;
  const lines = [
    { label: "Changed", value: `${plural(written, "change")}${agents.length > 0 ? ` to ${listJoin(agents)}` : ""}` },
    ...(counts.conflict > 0 ? [{ label: "Skipped", value: `${plural(counts.conflict, "conflict")}, yours to decide` }] : []),
    ...(counts.manual > 0 ? [{ label: "Manual", value: `${plural(counts.manual, "manual step")} in the plan, left to you` }] : []),
    ...(result.transaction_id ? [{ label: "Transaction", value: result.transaction_id }] : []),
  ];
  const allClear = counts.conflict === 0 && counts.manual === 0 && steps.length === 0;
  return (
    <div className="plan-done">
      <h3>{allClear ? "Everything is set up." : "Applied. The rest is yours to decide."}</h3>
      <Receipt lines={lines} />
      {steps.length > 0 && (
        <div className="plan-left">
          <b>Left for you</b>
          <ul>
            {steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The state of a row while the apply runs and after it: queued, writing, written, or skipped and left to you. */
function rowState(row: PlanRow, phase: PlanPhase, agentCurve: (agent: PlanAgentId) => PlanCurve | null): { text: string; tone: string } {
  if (row.conflict) return { text: "skipped", tone: "dim" };
  if (!row.safe) return { text: "left to you", tone: "dim" };
  if (phase === "done") return { text: "✓ written", tone: "ok" };
  const curve = agentCurve(planRowAgent(row));
  if (curve === "written") return { text: "✓ written", tone: "ok" };
  if (curve === "live") return { text: "writing…", tone: "live" };
  return { text: "queued", tone: "dim" };
}

function GroupIcon({ agent }: { agent: PlanAgentId }) {
  if (agent === "shared") return <RuneMark className="plan-gicon" />;
  return <AgentIcon harness={agent} decorative size={16} className="plan-gicon" />;
}

/**
 * The install review: a card in place of the page it was opened from. A summary band counts every kind of change;
 * beside the table a map shows what apply writes to each agent (a chip on the base's curve to it); the table lists the
 * rows by agent, the conflicts pinned first because apply never writes them, with a hollow mark and a word on every
 * row (a conflict is the one filled mark: it is the decision). It asks before anything is written; while the apply
 * runs the curves turn solid agent by agent and the rows tick, and once it succeeded the card stays as its receipt
 * with Undo until it is dismissed.
 *
 * Keys (focus inside the pane): `j`/`k` move (and light the row's agent on the map), `d` details of the row, `c` next
 * conflict, `y` apply (review only, and only when there is something safe to apply), `n`/Esc cancel or dismiss, `r`
 * preview again after a stale or expired preview. Enter never applies, not on the grid and not on the focused Apply
 * button; the `y apply` hint in the Apply button is clickable and does the same as the key.
 */
export function InstallPlanPane({
  flow,
  busyLabel,
  backupRoot,
  onApply,
  done = null,
  onDismiss,
  onUndo,
  progress = null,
  trace = null,
  flowBase = null,
  onOpenAgent,
}: InstallPlanPaneProps) {
  const { status, review, error, request } = flow;
  const open = status !== "idle" || done !== null;

  const tableRef = useRef<HTMLTableElement>(null);
  const tableId = useId();
  const phase: PlanPhase | null = done ? "done" : status === "applying" && review ? "applying" : status === "review" && review ? "review" : null;
  const shown = done ? done.review : phase ? review : null;
  const groups = useMemo(() => (shown ? buildPlanGroups(shown) : []), [shown]);
  const agentPlan = useMemo(() => buildAgentPlan(groups), [groups]);
  const rows = agentPlan.rows;
  const counts = useMemo(() => countPlanRows(groups), [groups]);
  const planFlow = useMemo(
    () => (phase ? buildPlanFlow(agentPlan, { base: flowBase, phase, trace: phase === "applying" ? trace : null }) : null),
    [agentPlan, flowBase, phase, trace],
  );
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The map lights the cursor row's agent once the user moves the cursor; at first it shows every agent alike.
  const [moved, setMoved] = useState(false);
  const shared = useSharedProgress(phase, progress, trace);

  const plan = shown?.plan;
  useEffect(() => {
    setCursor(0);
    setExpanded(new Set());
    setMoved(false);
  }, [plan]);

  // Take focus when the review (or its error) appears, unless the user already moved somewhere deliberate.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const pane = document.querySelector(`[data-pane-id="${INSTALL_PLAN_PANE_ID}"]`);
    const free =
      !active || active === document.body || !active.isConnected || pane?.contains(active) === true || active.closest(".shell-chrome") !== null;
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
  const activeAgent = activeRow && moved ? planRowAgent(activeRow) : null;

  const readOnly = request?.readOnly === true;
  const reviewing = phase === "review";
  const hasTable = phase !== null;
  const describe = describePlanCounts(counts);
  const agentCurve = (agent: PlanAgentId): PlanCurve | null =>
    agent === "shared" ? shared : (planFlow?.agents.find(entry => entry.id === agent)?.curve ?? null);
  const writtenAgents = (planFlow?.agents ?? []).filter(agent => agent.counts.create + agent.counts.update + agent.counts.remove > 0).map(agent => agent.label);
  const liveAgent = trace?.current ? HARNESS_LABELS[trace.current] : null;

  const question = (() => {
    if (done) {
      const skipped = counts.conflict > 0 ? `, ${counts.conflict} ${counts.conflict === 1 ? "conflict" : "conflicts"} skipped` : "";
      const left = done.result.manual_steps.length;
      const steps = left > 0 ? `, ${plural(left, "step")} left to you` : "";
      return `done at ${formatCheckedAt(new Date(done.at))} · ${plural(counts.create + counts.update + counts.remove, "change")} applied${skipped}${steps}`;
    }
    if (status === "previewing") return "computing the plan…";
    if (status === "applying") {
      if (progress?.phase === "backup") return "applying: backing up, then writing…";
      if (progress?.phase === "apply" && progress.total) return `applying: writing ${liveAgent ?? "files"}… ${progress.done} of ${plural(progress.total, "file")}`;
      return "applying: backing up, then writing…";
    }
    if (status === "error") return "nothing was written";
    if (readOnly) return `preview only: ${describe.startsWith("apply ") ? `would ${describe}` : describe}`;
    return review?.canApply ? `${describe}?` : describe;
  })();

  const moveTo = (next: number) => {
    if (rows.length === 0) return;
    const clamped = Math.min(rows.length - 1, Math.max(0, next));
    setCursor(clamped);
    setMoved(true);
    const id = rows[clamped]!.id;
    document.getElementById(rowDomId(id))?.scrollIntoView?.({ block: "nearest" });
  };

  const cancelState = (): boolean | string => {
    if (status === "applying") return "applying; it cannot be cancelled";
    return open;
  };

  const applyState = (): boolean | string => {
    if (status === "applying") return "applying…";
    if (!reviewing || !review || readOnly) return false;
    if (!review.canApply) return describe;
    if (busyLabel) return `${busyLabel} is running`;
    return true;
  };

  const close = () => {
    if (done) onDismiss?.();
    else flow.cancel();
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
    title: done ? "Dismiss the result" : readOnly ? "Close the preview" : "Cancel the review",
    hint: done ? "dismiss" : readOnly ? "close" : "cancel",
    group: "Install plan",
    scope: "pane",
    paneId: INSTALL_PLAN_PANE_ID,
    when: cancelState,
    run: close,
  };

  const toggleDetails = (rowId: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });

  const conflictAction: Binding = {
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
      when: () => (reviewing || phase === "done") && rows.length > 0,
      run: () => {
        if (activeRow) toggleDetails(activeRow.id);
      },
    },
    conflictAction,
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
      title: done ? "Dismiss the result" : readOnly ? "Close the preview" : "Cancel the review",
      group: "Install plan",
      scope: "global",
      when: () => status !== "applying" && open,
      run: close,
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

  const noteBackup = reviewing && !readOnly && review?.canApply === true;
  const transaction = done?.result.transaction_id || null;
  const footer = (
    <ReviewFooter
      question={question}
      backup={done ? { root: backupRoot, transaction } : noteBackup && { root: backupRoot }}
      facts={done ? ["Backed up", "Undo any time", "History keeps this run"] : undefined}
    >
      {done && onUndo && transaction && done.result.applied.length > 0 && (
        <TButton keys={["z"]} shortcut="z" onClick={() => onUndo(transaction)}>
          Undo this update…
        </TButton>
      )}
      <BindingButton binding={applyAction} apply />
      <BindingButton binding={cancelAction} />
      <BindingButton binding={conflictAction} />
    </ReviewFooter>
  );

  const label = request?.label ?? done?.review.request.label ?? "";
  const columns = phase === "review" ? 4 : 5;
  const showMap = planFlow !== null && planFlow.agents.length > 0;
  const conflictAgents = [...new Set(agentPlan.conflicts.map(planRowAgent))].filter((agent): agent is InstallAgent => agent !== "shared");

  const renderRow = (row: PlanRow) => {
    const isCursor = activeRow?.id === row.id;
    const isOpen = expanded.has(row.id);
    const state = phase && phase !== "review" ? rowState(row, phase, agentCurve) : null;
    return (
      <Fragment key={row.id}>
        <tr
          id={rowDomId(row.id)}
          className={cx(row.conflict && "conf", state?.tone === "ok" && "is-written")}
          aria-selected={isCursor}
          aria-expanded={isOpen}
          onClick={() => {
            tableRef.current?.focus();
            setCursor(rows.indexOf(row));
            setMoved(true);
          }}
        >
          <td className="cur" />
          <td className={cx("op", `op-${row.kind}`)}>
            <span className={`rv-mark rv-mark-${row.kind}`} aria-hidden="true" />
            {phase === "done" ? (DONE_WORD[row.kind] ?? row.label) : row.label}
            <button
              type="button"
              className="plan-more"
              aria-expanded={isOpen}
              aria-label={`details of ${row.file}`}
              onMouseDown={event => event.preventDefault()}
              onClick={event => {
                // The row's own click moves the cursor; this one also toggles, so it must not bubble twice.
                event.stopPropagation();
                tableRef.current?.focus();
                setCursor(rows.indexOf(row));
                setMoved(true);
                toggleDetails(row.id);
              }}
            >
              {isOpen ? "hide" : "details"}
            </button>
          </td>
          <td className="file" title={row.file}>
            {row.file}
          </td>
          <td className="note" title={row.note}>
            {row.conflict && (
              <>
                <span className="c-head">preserved, skipped</span>
                {row.note ? " · " : ""}
              </>
            )}
            {row.note}
          </td>
          {state && <td className={cx("state", `is-${state.tone}`)}>{state.text}</td>}
        </tr>
        {isOpen && (
          <tr className="detail">
            <td />
            <td colSpan={columns - 1}>
              {row.detail.map(line => (
                <div key={line}>{line}</div>
              ))}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const groupState = (group: AgentPlanGroup): { text: string; tone: string } | null => {
    if (phase === "done") return { text: "in sync", tone: "ok" };
    if (phase !== "applying" || !group.rows.some(row => row.safe)) return null;
    const curve = agentCurve(group.agent);
    if (curve === "written") return { text: "written", tone: "ok" };
    if (curve === "live") return { text: "writing", tone: "live" };
    return { text: "queued", tone: "dim" };
  };

  return (
    <Pane
      id={INSTALL_PLAN_PANE_ID}
      title={done ? `${installReviewLabel(label, counts).startsWith("install ") ? "Install" : "Update"} applied` : "Install plan"}
      label="Install plan"
      variant="card"
      className={cx("plan-card", phase && `is-${phase}`)}
      scrollable={!hasTable}
      defaultFocus
      meta={
        label ? (
          <>
            {hasTable ? installReviewLabel(label, counts) : label}
            {reviewing && (
              <>
                {` · ${groups.length} surface${groups.length === 1 ? "" : "s"} · `}
                <Counts counts={counts} />
              </>
            )}
            {phase === "applying" && " · applying"}
            {done && ` · ${formatCheckedAt(new Date(done.at))}`}
            {status === "previewing" && " · computing"}
            {status === "error" && " · failed"}
            {reviewing && !readOnly && <span className="plan-meta-end">nothing written yet</span>}
            {done && (
              <span className="plan-meta-end">
                <StatePill state="ok">Done</StatePill>
              </span>
            )}
          </>
        ) : null
      }
      footer={footer}
    >
      {status === "previewing" && !done && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">computing the plan for {request?.label}…</span>
        </div>
      )}

      {status === "error" && error && !done && (
        <div className="plan-state">
          <p className="rv-error" role="alert">
            <span className="rv-mark rv-mark-remove" aria-hidden="true" />
            {error.message}
          </p>
          <p className="c-dim">{ERROR_HINT[error.kind]}</p>
        </div>
      )}

      {hasTable && phase && (
        <>
          <SummaryBand counts={counts} rows={rows} phase={phase} />
          <div className={cx("plan-split", !showMap && "no-map")}>
            {(showMap || phase !== "review") && (
              <div className="plan-side">
                {showMap && <PlanFlowMap flow={planFlow} phase={phase} highlight={activeAgent === "shared" ? null : activeAgent} />}
                {phase === "applying" && <PlanProgress progress={progress} agent={liveAgent} />}
                {done && <DoneReceipt done={done} counts={counts} agents={writtenAgents} />}
              </div>
            )}
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
                  <th scope="col">
                    <span className="visually-hidden">cursor</span>
                  </th>
                  <th scope="col">Change</th>
                  <th scope="col">File</th>
                  <th scope="col">Why</th>
                  {columns === 5 && (
                    <th scope="col" className="state">
                      State
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {agentPlan.conflicts.length > 0 && (
                  <tr className="g g-skip">
                    <td colSpan={columns}>
                      <div className="gh">
                        <span className="rv-mark rv-mark-conflict" aria-hidden="true" />
                        <span className="gh-name">Skipped · needs your decision</span>
                        <span className="gh-tag">apply never writes it</span>
                        {onOpenAgent && conflictAgents.length > 0 && (
                          <span className="gh-end">
                            {conflictAgents.map(agent => (
                              <button key={agent} type="button" className="plan-open" onMouseDown={event => event.preventDefault()} onClick={() => onOpenAgent(agent)}>
                                Open {HARNESS_LABELS[agent]} →
                              </button>
                            ))}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                {agentPlan.conflicts.map(renderRow)}
                {agentPlan.groups.map(group => {
                  const word = groupState(group);
                  return (
                    <Fragment key={group.agent}>
                      <tr className={cx("g", activeAgent === group.agent && "is-lit")} data-agent={group.agent}>
                        <td colSpan={columns}>
                          <div className="gh">
                            <GroupIcon agent={group.agent} />
                            <span className="gh-name">{group.label}</span>
                            {group.agent === "shared" && <span className="gh-tag">every agent reads it</span>}
                            {word && <span className={cx("gh-state", `is-${word.tone}`)}>{word.text}</span>}
                            {group.unchanged.length > 0 && <span className="gh-end">{group.unchanged.join(", ")} · unchanged</span>}
                          </div>
                        </td>
                      </tr>
                      {group.rows.map(renderRow)}
                      {group.skipped.length > 0 && (
                        <tr className="unch">
                          <td />
                          <td colSpan={columns - 1}>
                            <span className="rv-mark rv-mark-conflict" aria-hidden="true" />
                            {group.skipped.map(row => row.file).join(", ")} {group.skipped.length === 1 ? "is" : "are"} skipped, see above
                            {group.rows.length === 0 && " · nothing else to write"}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td />
                    <td colSpan={columns - 1} className="c-dim">
                      nothing to change: every requested surface is current
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Pane>
  );
}

/**
 * Where the apply is in the shared folders (`~/.agents/skills`), which belong to no agent's folder: a file the trace
 * cannot give an agent is shared, and once the run moves on to an agent's file the shared ones are written.
 */
function useSharedProgress(phase: PlanPhase | null, progress: ApplyProgress | null, trace: RunTrace | null): PlanCurve | null {
  const [state, setState] = useState<PlanCurve>("write");
  useEffect(() => {
    if (phase !== "applying") {
      setState("write");
      return;
    }
    if (progress?.phase === "apply" && progress.file && trace && trace.current === null) setState("live");
    else if (trace?.current) setState(previous => (previous === "live" ? "written" : previous));
  }, [phase, progress, trace]);
  if (phase === "done") return "written";
  if (phase === "applying" && !trace) return "live";
  return phase === "applying" ? state : null;
}
