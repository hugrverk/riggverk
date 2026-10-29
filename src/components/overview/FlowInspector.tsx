import type { ReactNode } from "react";
import { homePill, resolveRef, type FlowDecision, type FlowFix, type FlowModel, type FlowRef, type RunTrace } from "../../lib/flowModel";
import { receiptLines, updateAgentsText, updateTimeText } from "../../lib/lastUpdate";
import type { RulesOverrideWarning } from "../../lib/rulesView";
import type { UiState } from "../../lib/uiState";
import type { ApplyProgress, InstallAgent, SetupHistoryEntry } from "../../types";
import { StateMark, StatePill } from "../../ui/StatePill";
import { TButton } from "../../ui/TButton";
import { Receipt } from "../run/Receipt";
import { AgentView, EdgeView, Heading, Label, RunningView, runPhaseWord, SourceView, type InspectorActions } from "./FlowInspectorViews";

export interface FlowInspectorRun {
  /** The task's label (`wsRunning`). */
  label: string;
  progress: ApplyProgress | null;
  trace: RunTrace;
  startAgents: readonly InstallAgent[];
}

export interface FlowInspectorProps extends InspectorActions {
  model: FlowModel;
  selected: FlowRef | null;
  counts: Record<UiState, number>;
  installing: boolean;
  decisions: readonly FlowDecision[];
  /** Agents with rows to fix by hand; listed next to the decisions. */
  fixes: readonly FlowFix[];
  lastUpdate: SetupHistoryEntry | null;
  backupCount: number;
  /** Set while a task runs: the inspector shows it instead of the selection. */
  run: FlowInspectorRun | null;
  codexOverride: RulesOverrideWarning | null;
  /** Why Install everything cannot start right now, or false. */
  installDisabled: string | false;
  onInstall: () => void;
}

function HomeView({ props }: { props: FlowInspectorProps }) {
  const { counts, installing, decisions, fixes, lastUpdate, backupCount, onNavigate } = props;
  const pill = homePill(counts, installing);
  const title = lastUpdate ? ["Last update", updateAgentsText(lastUpdate), updateTimeText(lastUpdate)].filter(Boolean).join(" · ") : null;
  return (
    <>
      <Heading pill={pill && <StatePill state={pill.state}>{pill.text}</StatePill>}>Overview</Heading>
      {decisions.map(decision => (
        <div key={decision.harness} className="flow-dec">
          <StateMark state="decide" />
          <div>
            <b>
              {decision.label} · {decision.rows.map(row => row.label).join(", ") || "needs your decision"}
            </b>
            <span className="flow-dim">{decision.reason ?? "Your file is kept until you decide."}</span>
          </div>
          <div className="flow-acts">
            <TButton keys={[]} onClick={() => onNavigate(decision.harness)}>
              Open {decision.label}
            </TButton>
          </div>
        </div>
      ))}
      {fixes.map(fix => (
        <div key={fix.harness} className="flow-dec flow-fix">
          <StateMark state="fix" />
          <div>
            <b>
              {fix.label} · {fix.rows.map(row => row.label).join(", ")} to fix by hand
            </b>
            {fix.rows.map(row => (
              <span key={row.label} className="flow-dim">
                {row.label}: {row.reason ?? "Riggverk leaves it alone until you repair it."}
              </span>
            ))}
          </div>
          <div className="flow-acts">
            <TButton keys={[]} onClick={() => onNavigate(fix.harness)}>
              Open {fix.label}
            </TButton>
          </div>
        </div>
      ))}
      {installing && (
        <>
          <p>Nothing is installed yet.</p>
          <div className="flow-acts">
            <TButton keys={[]} variant="primary" disabled={props.installDisabled} onClick={props.onInstall}>
              Install everything
            </TButton>
          </div>
          <p className="flow-dim">Backs up first; nothing is written before you confirm.</p>
        </>
      )}
      {lastUpdate && (
        <div className="flow-receipt">
          <div className="flow-ih">
            <Label>{title}</Label>
            {lastUpdate.status === "rolled_back" && <StatePill state="tip">Undone</StatePill>}
          </div>
          <Receipt lines={receiptLines(lastUpdate, backupCount)} />
          <div className="flow-acts">
            {lastUpdate.undoable && (
              <TButton keys={[]} disabled={props.undoDisabled} onClick={() => props.onUndo(lastUpdate.transaction_id)}>
                Undo this update…
              </TButton>
            )}
            <TButton keys={[]} onClick={() => onNavigate("history")}>
              History
            </TButton>
          </div>
        </div>
      )}
      {!installing && <p className="flow-dim">Select a source, an agent or a curve to inspect it. Esc clears the selection.</p>}
    </>
  );
}

/**
 * The panel beside the map. It is always filled: with nothing selected the verdict, anything to decide, Install
 * everything on a fresh profile and the receipt of the last update with Undo and History; with a node or a curve
 * selected that node's own details and actions; while a task runs its progress, the file in progress and the agents it
 * has reached. A polite live region, so a change of view is read out. Every action is a real button.
 */
export function FlowInspector(props: FlowInspectorProps) {
  const { model, run } = props;
  const selected = resolveRef(model, props.selected);
  let view: { key: string; body: ReactNode };
  if (run) {
    view = { key: "run", body: <RunningView label={run.label} progress={run.progress} trace={run.trace} startAgents={run.startAgents} /> };
  } else if (selected?.type === "agent") {
    const agent = model.agents.find(entry => entry.id === selected.id)!;
    view = {
      key: `agent:${agent.id}`,
      body: <AgentView agent={agent} model={model} lastUpdate={props.lastUpdate} override={agent.id === "codex" ? props.codexOverride : null} actions={props} />,
    };
  } else if (selected?.type === "source") {
    view = { key: `source:${selected.id}`, body: <SourceView source={model.sources.find(entry => entry.id === selected.id)!} model={model} actions={props} /> };
  } else if (selected?.type === "edge") {
    view = { key: `edge:${selected.id}`, body: <EdgeView edge={model.edges.find(entry => entry.id === selected.id)!} model={model} actions={props} /> };
  } else {
    view = { key: "home", body: <HomeView props={props} /> };
  }
  return (
    // A polite live region reads a change of view out. While a task runs the file and the checklist change on every
    // progress event, so the region goes quiet and a status of its own announces the phase only.
    <aside className="flow-insp" aria-live={run ? "off" : "polite"} aria-label="Details">
      {run && (
        <span className="visually-hidden" role="status">
          {`${run.label.charAt(0).toUpperCase()}${run.label.slice(1)}: ${runPhaseWord(run.progress)}`}
        </span>
      )}
      <div className="flow-body" key={view.key}>
        {view.body}
      </div>
    </aside>
  );
}
