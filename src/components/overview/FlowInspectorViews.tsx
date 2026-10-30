import type { CSSProperties, ReactNode } from "react";
import {
  agentsReachedBy,
  countText,
  itemText,
  receivedBy,
  runChecklist,
  sourcesFeeding,
  type FlowAgent,
  type FlowEdge,
  type FlowModel,
  type FlowSource,
  type RunTrace,
} from "../../lib/flowModel";
import { agentReceipt, updateTimeText } from "../../lib/lastUpdate";
import { listText, type CardRow } from "../../lib/overviewModel";
import type { RulesOverrideWarning } from "../../lib/rulesView";
import type { UiState } from "../../lib/uiState";
import type { ApplyProgress, InstallAgent, SetupHistoryEntry } from "../../types";
import type { AppView } from "../../shell/views";
import { StateMark, StatePill, type StatePillKind } from "../../ui/StatePill";
import { AgentIcon, type AgentBadgeState } from "../../ui/agentIcons";
import { TButton } from "../../ui/TButton";
import { Receipt } from "../run/Receipt";

export interface InspectorActions {
  onNavigate: (view: AppView) => void;
  onUndo: (transactionId: string) => void;
  /** Why Undo cannot start right now (a task is running), or false. */
  undoDisabled: string | false;
}

export const Heading = ({ children, pill, icon }: { children: ReactNode; pill?: ReactNode; icon?: ReactNode }) => (
  <div className="flow-ih">
    <h3 className="flow-h">
      {icon}
      {children}
    </h3>
    {pill}
  </div>
);

export const Label = ({ children }: { children: ReactNode }) => <span className="flow-lbl">{children}</span>;

function Rows({ label, rows }: { label: string; rows: Array<{ key: string; name: string; state?: StatePillKind | null; text: string }> }) {
  return (
    <ul className="flow-rows" aria-label={label}>
      {rows.map(row => (
        <li key={row.key}>
          <span>{row.name}</span>
          <span className="flow-val">
            {row.state && <StateMark state={row.state} />}
            {row.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

const ROW_COUNT_KEY: Record<string, "agents" | "skills" | undefined> = { Agents: "agents", Skills: "skills" };

/** The words of a row: its count where the Overview reads one (skills, agents), then its state. */
function rowText(row: CardRow, received: ReturnType<typeof receivedBy>): string {
  const key = ROW_COUNT_KEY[row.label];
  const n = key ? received[key] : undefined;
  return n ? `${countText(n, key === "agents" ? ["agent", "agents"] : ["skill", "skills"])} · ${row.text}` : row.text;
}

/** "Last update · Claude and Codex · 15:39" is the Overview's; this is its short form for one agent. */
function receiptHeading(entry: SetupHistoryEntry): string {
  return ["Last update", updateTimeText(entry)].filter(Boolean).join(" · ");
}

export function AgentView({
  agent,
  model,
  lastUpdate,
  override,
  actions,
}: {
  agent: FlowAgent;
  model: FlowModel;
  lastUpdate: SetupHistoryEntry | null;
  override: RulesOverrideWarning | null;
  actions: InspectorActions;
}) {
  const pillState: StatePillKind = agent.status === "active" ? (agent.state ?? "off") : "off";
  const pill = <StatePill state={pillState}>{agent.pillText}</StatePill>;
  // The icon is decorative here: the name and the pill beside it say the state in words.
  const badge: AgentBadgeState = agent.status === "active" ? (agent.decision ? "decide" : (agent.state ?? "off")) : agent.status;
  const icon = <AgentIcon harness={agent.id} state={badge} decorative />;
  if (agent.status !== "active" || !agent.card) {
    return (
      <>
        <Heading pill={pill} icon={icon}>{agent.label}</Heading>
        <p className="flow-dim">
          {agent.status === "missing" ? "Turned on, but not found on this Mac. Nothing flows to it." : "Off in Settings. Nothing flows to it."}
        </p>
        <div className="flow-acts">
          <TButton keys={[]} onClick={() => actions.onNavigate("settings")}>
            Open Settings
          </TButton>
        </div>
      </>
    );
  }
  const card = agent.card;
  const received = receivedBy(model, agent.id);
  const feeding = sourcesFeeding(model, agent.id);
  const receipt = lastUpdate ? agentReceipt(lastUpdate, agent.id) : null;
  return (
    <>
      <Heading pill={pill} icon={icon}>{agent.label}</Heading>
      <Rows
        label={`${agent.label} surfaces`}
        rows={card.rows.map(row => ({ key: row.surface, name: row.label, state: row.state, text: rowText(row, received) }))}
      />
      {override && (
        <p className="flow-alert" role="alert">
          <b>{override.title}.</b> {override.detail}
        </p>
      )}
      {card.notes.length > 0 && (
        <div className="flow-dim flow-notes">
          {card.notes.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
        </div>
      )}
      {feeding.length > 0 && (
        <div>
          <Label>From</Label>
          <p>{listText(feeding.map(source => source.label))}</p>
        </div>
      )}
      {lastUpdate &&
        (receipt?.part ? (
          <div className="flow-receipt">
            <Label>{receiptHeading(lastUpdate)}</Label>
            <Receipt lines={receipt.lines} />
          </div>
        ) : (
          <p className="flow-dim">Not part of the last update.</p>
        ))}
      <div className="flow-acts">
        <TButton keys={[]} onClick={() => actions.onNavigate(agent.id)}>
          Open {agent.label}
        </TButton>
        {lastUpdate?.undoable && receipt?.part && (
          <TButton keys={[]} disabled={actions.undoDisabled} onClick={() => actions.onUndo(lastUpdate.transaction_id)}>
            Undo this update…
          </TButton>
        )}
      </div>
    </>
  );
}

export function OffGroupView({ agents, actions }: { agents: FlowAgent[]; actions: InspectorActions }) {
  return (
    <>
      <Heading>{agents.length} off</Heading>
      <p className="flow-dim">Off in Settings. Nothing flows to {agents.length === 1 ? "it" : "them"}.</p>
      <ul className="flow-rows flow-off-list" aria-label="Agents off">
        {agents.map(agent => <li key={agent.id}><span><AgentIcon harness={agent.id} state="off" decorative /> {agent.label}</span></li>)}
      </ul>
      <div className="flow-acts"><TButton keys={[]} onClick={() => actions.onNavigate("settings")}>Open Settings</TButton></div>
    </>
  );
}

const SOURCE_PILL: Record<FlowSource["kind"], { state: StatePillKind; text: string }> = {
  base: { state: "tip", text: "Base" },
  yours: { state: "yours", text: "Yours" },
  pack: { state: "tip", text: "Pack" },
};

const SOURCE_REACH: Record<FlowSource["kind"], string> = {
  base: "every agent that is on",
  yours: "the agents whose rules file has refinements",
  pack: "every agent that installs skills",
};

export function SourceView({ source, model, actions }: { source: FlowSource; model: FlowModel; actions: InspectorActions }) {
  const reached = agentsReachedBy(model, source.id);
  const pill = source.state === "fix" ? { state: "fix" as const, text: "Held" } : SOURCE_PILL[source.kind];
  return (
    <>
      <Heading pill={<StatePill state={pill.state}>{pill.text}</StatePill>}>{source.label}</Heading>
      {source.items.length > 0 && (
        <Rows label={`${source.label} contents`} rows={source.items.map(entry => ({ key: entry.key, name: entry.label, text: itemText(entry) }))} />
      )}
      <div>
        <Label>Reaches</Label>
        <p>
          {listText(reached.map(agent => agent.label)) || "no agent yet"} <span className="flow-dim">· {SOURCE_REACH[source.kind]}</span>
        </p>
      </div>
      {source.notes.map(note => (
        <p key={note} className="flow-dim">
          {note}
        </p>
      ))}
      <div className="flow-acts">
        <TButton keys={[]} onClick={() => actions.onNavigate("library")}>
          Open in Library
        </TButton>
      </div>
    </>
  );
}

function edgePill(edge: FlowEdge, agent: FlowAgent): { state: UiState; text: string } {
  if (edge.status === "fix") return { state: "fix", text: "Held" };
  if (agent.sub === "not installed") return { state: "ready", text: "Will flow" };
  return edge.status === "ready" ? { state: "ready", text: "Update ready" } : { state: "ok", text: "Flowing" };
}

export function EdgeView({ edge, model, actions }: { edge: FlowEdge; model: FlowModel; actions: InspectorActions }) {
  const source = model.sources.find(entry => entry.id === edge.source)!;
  const agent = model.agents.find(entry => entry.id === edge.agent)!;
  const pill = edgePill(edge, agent);
  return (
    <>
      <Heading pill={<StatePill state={pill.state}>{pill.text}</StatePill>}>
        {source.label} → {agent.label}
      </Heading>
      <Rows label="Items on this curve" rows={edge.items.map(entry => ({ key: entry.key, name: entry.label, text: itemText(entry) }))} />
      <p className="flow-dim">
        {countText(edge.total, ["item", "items"])} on this curve. {source.label} reaches {SOURCE_REACH[source.kind]}.
      </p>
      <div className="flow-acts">
        <TButton keys={[]} onClick={() => actions.onNavigate(agent.id)}>
          Open {agent.label}
        </TButton>
        <TButton keys={[]} onClick={() => actions.onNavigate("library")}>
          Open in Library
        </TButton>
      </div>
    </>
  );
}

/** The word for the run's phase: what a screen reader hears when it changes. */
export function runPhaseWord(progress: ApplyProgress | null): string {
  return progress?.phase === "backup" ? "Backing up" : progress?.phase === "apply" ? "Writing" : "Working";
}

export function RunningView({
  label,
  progress,
  trace,
  startAgents,
}: {
  label: string;
  progress: ApplyProgress | null;
  trace: RunTrace;
  startAgents: readonly InstallAgent[];
}) {
  const total = progress?.total ?? null;
  const counted = progress && progress.phase !== "backup" && total !== null && total > 0;
  const ratio = counted ? Math.min(1, Math.max(0, progress.done / total)) : 0;
  const checklist = runChecklist(trace, startAgents);
  const phase = runPhaseWord(progress);
  return (
    <>
      <Heading pill={<StatePill state="ready">{phase}</StatePill>}>{label.charAt(0).toUpperCase() + label.slice(1)}</Heading>
      {counted && (
        <div className="flow-progress">
          <span
            className="flow-bar"
            role="progressbar"
            aria-label="Update progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(progress.done, total)}
            aria-valuetext={`${progress.done} of ${total}`}
            style={{ "--p": `${Math.round(ratio * 100)}%` } as CSSProperties}
          >
            <i aria-hidden="true" />
          </span>
          <span className="flow-count">
            {progress.done}/{total}
          </span>
        </div>
      )}
      <span className="flow-file" title={progress?.file ?? undefined}>
        {progress?.file ?? (progress?.phase === "backup" ? "backing up first…" : "working…")}
      </span>
      {checklist.length > 0 && (
        <ul className="flow-check" aria-label="Agents in this run">
          {checklist.map(row => (
            <li key={row.agent} className={row.state === "current" ? "is-current" : undefined}>
              <StateMark state={row.state === "done" ? "ok" : row.state === "current" ? "ready" : "off"} />
              <span>{row.label}</span>
              <span className="flow-val">{row.state === "waiting" ? "waiting" : countText(row.files, ["file", "files"])}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="flow-dim">Every file is backed up before it is written. Undo is offered the moment the run ends.</p>
    </>
  );
}
