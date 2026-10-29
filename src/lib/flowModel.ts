import type { ApplyProgress, InstallAgent, PackLibrary, RulesFileSummary, SetupHistoryEntry } from "../types";
import { HARNESS_LABELS, HARNESS_NAV_ORDER, HARNESS_SURFACES, harnessForSurface } from "./harnessInstallation";
import { surfaceShortName } from "./installationView";
import type { AgentCardModel, CardRow } from "./overviewModel";
import { READY_TO_INSTALL_LABEL, UI_STATE_LABEL, UI_STATE_PRECEDENCE, type UiState } from "./uiState";

/**
 * The model behind the Overview's flow map: what flows from each source (Riggverk base, your refinements, one node per
 * skill pack) to each agent, built only from what the Overview and the Library already read. Nothing here touches the
 * DOM or the backend; a count that no read command gives is left out rather than guessed.
 */

export type FlowSurface = "rules" | "agents" | "skills" | "config" | "mcp";
export type FlowSourceKind = "base" | "yours" | "pack";
/** `ok` flows, `ready` flows once the update is applied (dashed), `ghost` goes to an agent that is off or missing, `fix` is a pack that is held. */
export type FlowEdgeStatus = "ok" | "ready" | "ghost" | "fix";
export type FlowAgentStatus = "active" | "off" | "missing";

export interface FlowItem {
  key: string;
  label: string;
  n: number;
  unit: readonly [string, string];
}

export interface FlowSource {
  id: string;
  kind: FlowSourceKind;
  label: string;
  /** `fix`: a pack whose skills are held or missing, or that cannot be read. */
  state: "ok" | "fix";
  items: FlowItem[];
  /** The items added up: what "N items" in the map says. */
  total: number;
  notes: string[];
}

export interface FlowAgent {
  id: InstallAgent;
  label: string;
  status: FlowAgentStatus;
  /** The card's aggregate state; null while nothing in it is counted, and for agents that are off or missing. */
  state: UiState | null;
  /** True when any row of the agent needs a decision: the node is a filled square. */
  decision: boolean;
  /** The line under the name ("4 of 4 in sync", "update ready", "off in Settings"). */
  sub: string;
  /** The words of the agent's pill. */
  pillText: string;
  card: AgentCardModel | null;
}

export interface FlowEdge {
  id: string;
  source: string;
  agent: InstallAgent;
  items: FlowItem[];
  total: number;
  status: FlowEdgeStatus;
  /** The agent was written by the newest update that was not undone. */
  glow: boolean;
}

export interface FlowModel {
  sources: FlowSource[];
  agents: FlowAgent[];
  edges: FlowEdge[];
}

/** What `useFlowSources` reads; each part is null while it is unknown or could not be read. */
export interface FlowSourceData {
  bundledSkills: number | null;
  bundledAgents: number | null;
  rulesFiles: RulesFileSummary[] | null;
  packs: PackLibrary | null;
}

export const BASE_SOURCE_ID = "base";
export const YOURS_SOURCE_ID = "yours";
export const packSourceId = (name: string): string => `pack:${name}`;
export const edgeId = (source: string, agent: InstallAgent): string => `${source}>${agent}`;

const SURFACE_LABEL: Record<FlowSurface, string> = { rules: "Rules", agents: "Agents", skills: "Skills", config: "Settings", mcp: "MCP" };

const FLOW_SURFACES: readonly FlowSurface[] = ["rules", "agents", "skills", "config", "mcp"];

function isFlowSurface(value: string): value is FlowSurface {
  return (FLOW_SURFACES as readonly string[]).includes(value);
}

export function countText(n: number, unit: readonly [string, string]): string {
  return `${n} ${n === 1 ? unit[0] : unit[1]}`;
}

export function itemText(item: FlowItem): string {
  return countText(item.n, item.unit);
}

/** How heavy a curve is drawn for this many items: a logarithm, so a base of 37 is heavier than a pack of 5 without hiding it. */
export function lineWeight(n: number): number {
  return Number((0.8 + Math.log2(n + 1) * 0.38).toFixed(2));
}

function sum(items: readonly FlowItem[]): number {
  return items.reduce((total, item) => total + item.n, 0);
}

function item(key: string, label: string, n: number, unit: readonly [string, string]): FlowItem {
  return { key, label, n, unit };
}

const FILE_UNIT = ["file", "files"] as const;

/** The surfaces of an agent the base reaches: the rows of its card that are managed, or the harness's own list while it has no card. */
function managedSurfaces(card: AgentCardModel | null, harness: InstallAgent): FlowSurface[] {
  const surfaces = card
    ? card.rows.filter(row => row.state !== "off").map(row => surfaceShortName(row.surface))
    : HARNESS_SURFACES[harness].map(surfaceShortName);
  return FLOW_SURFACES.filter(kind => surfaces.includes(kind));
}

function baseItemsFor(kinds: readonly FlowSurface[], data: FlowSourceData | null): FlowItem[] {
  const items: FlowItem[] = [];
  for (const kind of kinds) {
    if (kind === "rules") items.push(item("rules", SURFACE_LABEL.rules, 1, FILE_UNIT));
    else if (kind === "agents" && data?.bundledAgents != null) items.push(item("agents", SURFACE_LABEL.agents, data.bundledAgents, ["agent", "agents"]));
    else if (kind === "skills" && data?.bundledSkills != null) items.push(item("skills", SURFACE_LABEL.skills, data.bundledSkills, ["skill", "skills"]));
    else if (kind === "config") items.push(item("config", SURFACE_LABEL.config, 1, FILE_UNIT));
    else if (kind === "mcp") items.push(item("mcp", SURFACE_LABEL.mcp, 1, ["entry", "entries"]));
  }
  return items.filter(entry => entry.n > 0);
}

interface PackSummary {
  name: string;
  active: number;
  held: number;
  shadowed: number;
  listed: number;
  broken: boolean;
  reasons: string[];
}

function packSummaries(library: PackLibrary | null): PackSummary[] {
  if (!library) return [];
  return library.packs.map(pack => {
    const skills = library.skills.filter(skill => skill.pack === pack.name);
    const held = skills.filter(skill => skill.state === "missing" || skill.state === "error");
    const reasons = [
      ...(pack.state !== "ok" && pack.reason ? [pack.reason] : []),
      ...held.map(skill => skill.reason).filter(Boolean),
    ];
    return {
      name: pack.name,
      active: skills.filter(skill => skill.state === "active").length,
      held: held.length,
      shadowed: skills.filter(skill => skill.state === "shadowed").length,
      listed: skills.length,
      broken: pack.state !== "ok" || held.length > 0,
      reasons: [...new Set(reasons)],
    };
  });
}

const SKILLS_UNIT = ["skill", "skills"] as const;

/** The agents the newest update that still stands wrote to: the harnesses it names and those whose surfaces it changed. */
export function agentsWritten(entry: SetupHistoryEntry | null): Set<InstallAgent> {
  const written = new Set<InstallAgent>();
  if (!entry || entry.status !== "applied") return written;
  for (const harness of entry.harnesses) written.add(harness);
  for (const change of entry.changes) {
    const harness = harnessForSurface(change.surface);
    if (change.applied && !change.restored && harness) written.add(harness);
  }
  return written;
}

function agentSub(card: AgentCardModel): string {
  if (card.unchecked === "failed") return "check failed";
  if (card.unchecked === "folder") return "workspace folder unusable";
  if (card.unchecked === "loading" || !card.badge) return "checking…";
  const first = (state: UiState) => card.rows.find(row => row.state === state);
  switch (card.badge.state) {
    case "decide":
      return `${first("decide")?.label ?? "Rules"} · needs decision`;
    case "fix":
      return `${first("fix")?.label ?? "Settings"} · fix by hand`;
    case "ready":
      return card.badge.text === READY_TO_INSTALL_LABEL ? "not installed" : "update ready";
    case "yours":
      return `${first("yours")?.label ?? "Rules"} · yours`;
    case "off":
      return "not managed";
    case "ok": {
      const counted = card.rows.filter(row => row.state !== null && row.state !== "off");
      const inSync = counted.filter(row => row.state === "ok").length;
      return `${inSync} of ${counted.length} in sync`;
    }
  }
}

function flowAgent(harness: InstallAgent, card: AgentCardModel | undefined): FlowAgent {
  const label = HARNESS_LABELS[harness];
  if (!card) return { id: harness, label, status: "off", state: null, decision: false, sub: "off in Settings", pillText: "Off", card: null };
  if (card.unavailable) {
    return { id: harness, label, status: "missing", state: null, decision: false, sub: "not on this Mac", pillText: "Not on this Mac", card };
  }
  // Nothing counted: "checking…" only while the fetch runs. A check that failed or a folder that is unusable gets the fix ring and says so.
  const { unchecked } = card;
  const stuck = unchecked === "failed" || unchecked === "folder";
  return {
    id: harness,
    label,
    status: "active",
    state: stuck ? "fix" : unchecked ? null : (card.badge?.state ?? null),
    decision: !unchecked && card.badge?.state === "decide",
    sub: agentSub(card),
    pillText: stuck ? (unchecked === "failed" ? "Couldn't check" : "Folder unusable") : unchecked ? "Checking…" : (card.badge?.text ?? "Checking…"),
    card,
  };
}

/** Builds the sources, the agents and the curves between them from the cards, the source reads and the newest update. */
export function buildFlowModel(input: {
  cards: readonly AgentCardModel[];
  sources: FlowSourceData | null;
  /** Personal docs in the data folder, from the workspace row; null when it did not say. */
  personalDocs: number | null;
  lastUpdate: SetupHistoryEntry | null;
}): FlowModel {
  const { cards, sources: data, personalDocs, lastUpdate } = input;
  const agents = HARNESS_NAV_ORDER.map(harness => flowAgent(harness, cards.find(card => card.harness === harness)));
  const active = agents.filter(agent => agent.status === "active");
  const written = agentsWritten(lastUpdate);

  const sources: FlowSource[] = [];
  const edges: FlowEdge[] = [];
  const push = (edge: Omit<FlowEdge, "id" | "total" | "glow">) => {
    const total = sum(edge.items);
    if (total <= 0) return;
    const flowing = edge.status === "ok" || edge.status === "ready";
    edges.push({ ...edge, id: edgeId(edge.source, edge.agent), total, glow: flowing && written.has(edge.agent) });
  };
  const flowStatus = (agent: FlowAgent): FlowEdgeStatus => (agent.state === "ready" ? "ready" : "ok");

  // Riggverk base: every enabled agent gets the managed surfaces it has; one that is off or missing only gets a ghost curve.
  const baseItems: FlowItem[] = [];
  if (data?.bundledSkills != null) baseItems.push(item("skills", SURFACE_LABEL.skills, data.bundledSkills, SKILLS_UNIT));
  if (data?.bundledAgents != null) baseItems.push(item("agents", SURFACE_LABEL.agents, data.bundledAgents, ["agent", "agents"]));
  if (data?.rulesFiles) baseItems.push(item("rules", SURFACE_LABEL.rules, data.rulesFiles.length, ["rules file", "rules files"]));
  const baseSource: FlowSource = {
    id: BASE_SOURCE_ID,
    kind: "base",
    label: "Riggverk base",
    state: "ok",
    items: baseItems.filter(entry => entry.n > 0),
    total: sum(baseItems),
    notes: [],
  };
  sources.push(baseSource);
  for (const agent of agents) {
    const items = baseItemsFor(managedSurfaces(agent.status === "active" ? agent.card : null, agent.id), data);
    push({ source: BASE_SOURCE_ID, agent: agent.id, items, status: agent.status === "active" ? flowStatus(agent) : "ghost" });
  }

  // Your refinements: the lines you keep below the managed block reach the agents whose rules file has some.
  const refined = (data?.rulesFiles ?? []).filter(file => file.refinement_lines > 0);
  const lines = refined.reduce((total, file) => total + file.refinement_lines, 0);
  const docs = personalDocs && personalDocs > 0 ? personalDocs : 0;
  if (lines > 0 || docs > 0) {
    const items = [
      ...(lines > 0 ? [item("refinements", "Refinements", lines, ["line", "lines"])] : []),
      ...(docs > 0 ? [item("docs", "Personal docs", docs, ["doc", "docs"])] : []),
    ];
    sources.push({ id: YOURS_SOURCE_ID, kind: "yours", label: "Your refinements", state: "ok", items, total: sum(items), notes: [] });
    for (const file of refined) {
      const harness = harnessForSurface(file.surface);
      const agent = active.find(entry => entry.id === harness);
      if (!agent) continue;
      push({ source: YOURS_SOURCE_ID, agent: agent.id, items: [item("refinements", "Refinements", file.refinement_lines, ["line", "lines"])], status: flowStatus(agent) });
    }
  }

  // One node per skill pack: its active skills reach every enabled agent that installs skills. A pack that is held shows a fix ring.
  for (const pack of packSummaries(data?.packs ?? null)) {
    const id = packSourceId(pack.name);
    const flowing = pack.broken ? Math.max(1, pack.listed) : pack.active;
    const items = [item("skills", SURFACE_LABEL.skills, pack.broken ? flowing : pack.active, SKILLS_UNIT)].filter(entry => entry.n > 0);
    const notes = [
      ...(pack.broken ? pack.reasons : []),
      ...(pack.shadowed > 0 ? [`${countText(pack.shadowed, SKILLS_UNIT)} shadowed by a bundled skill of the same name`] : []),
    ];
    sources.push({ id, kind: "pack", label: pack.name, state: pack.broken ? "fix" : "ok", items, total: sum(items), notes });
    for (const agent of active) {
      if (!managedSurfaces(agent.card, agent.id).includes("skills")) continue;
      push({ source: id, agent: agent.id, items, status: pack.broken ? "fix" : flowStatus(agent) });
    }
  }

  return { sources, agents, edges };
}

/* ---- selection and highlight ---- */

export type FlowRef = { type: "source" | "agent" | "edge"; id: string };

export function sameRef(a: FlowRef | null, b: FlowRef | null): boolean {
  return a === b || (!!a && !!b && a.type === b.type && a.id === b.id);
}

/** A reference that points at something the model no longer has is no reference. */
export function resolveRef(model: FlowModel, ref: FlowRef | null): FlowRef | null {
  if (!ref) return null;
  const found =
    ref.type === "source"
      ? model.sources.some(source => source.id === ref.id)
      : ref.type === "agent"
        ? model.agents.some(agent => agent.id === ref.id)
        : model.edges.some(edge => edge.id === ref.id);
  return found ? ref : null;
}

export interface FlowHighlight {
  sources: ReadonlySet<string>;
  agents: ReadonlySet<InstallAgent>;
  edges: ReadonlySet<string>;
}

/** What lights up for a node or a curve: the node itself, its curves and the nodes at their other ends. */
export function highlightOf(model: FlowModel, ref: FlowRef | null): FlowHighlight | null {
  if (!ref) return null;
  const sources = new Set<string>();
  const agents = new Set<InstallAgent>();
  const edges = new Set<string>();
  const take = (edge: FlowEdge) => {
    edges.add(edge.id);
    sources.add(edge.source);
    agents.add(edge.agent);
  };
  if (ref.type === "edge") {
    const edge = model.edges.find(entry => entry.id === ref.id);
    if (edge) take(edge);
  } else {
    if (ref.type === "source") sources.add(ref.id);
    else agents.add(ref.id as InstallAgent);
    for (const edge of model.edges) if (edge.source === ref.id || edge.agent === ref.id) take(edge);
  }
  return { sources, agents, edges };
}

/** The agents a source reaches, by their curves; ghost curves do not count. */
export function agentsReachedBy(model: FlowModel, sourceId: string): FlowAgent[] {
  const ids = new Set(model.edges.filter(edge => edge.source === sourceId && flows(edge)).map(edge => edge.agent));
  return model.agents.filter(agent => ids.has(agent.id));
}

/** A curve that carries something now: not a ghost to an agent that is off, not a pack that is held. */
const flows = (edge: FlowEdge): boolean => edge.status === "ok" || edge.status === "ready";

/** The sources that feed an agent, by their curves. */
export function sourcesFeeding(model: FlowModel, agent: InstallAgent): FlowSource[] {
  const ids = new Set(model.edges.filter(edge => edge.agent === agent && flows(edge)).map(edge => edge.source));
  return model.sources.filter(source => ids.has(source.id));
}

/** What the surfaces of one agent receive in total, by surface kind: skills from the base and from every pack. */
export function receivedBy(model: FlowModel, agent: InstallAgent): Partial<Record<FlowSurface, number>> {
  const received: Partial<Record<FlowSurface, number>> = {};
  for (const edge of model.edges) {
    if (edge.agent !== agent || !flows(edge)) continue;
    for (const entry of edge.items) if (isFlowSurface(entry.key)) received[entry.key] = (received[entry.key] ?? 0) + entry.n;
  }
  return received;
}

/* ---- the Overview's words ---- */

/** The pill at the top of the inspector's home view: the most urgent state that is counted, in words. Null while nothing is counted. */
export function homePill(counts: Record<UiState, number>, installing: boolean): { state: UiState; text: string } | null {
  const state = UI_STATE_PRECEDENCE.find(candidate => counts[candidate] > 0);
  if (!state) return null;
  if (state === "decide") return { state, text: `${counts.decide} to decide` };
  if (state === "fix") return { state, text: `${counts.fix} to fix` };
  if (state === "ready" && installing) return { state, text: READY_TO_INSTALL_LABEL };
  return { state, text: UI_STATE_LABEL[state] };
}

export interface FlowDecision {
  harness: InstallAgent;
  label: string;
  rows: CardRow[];
  /** Why, in the card's own words ("You edited the managed block"). */
  reason: string | null;
}

/** The agents with something to decide, in card order. */
export function decisionsOf(cards: readonly AgentCardModel[]): FlowDecision[] {
  return cards
    .filter(card => card.badge?.state === "decide")
    .map(card => ({ harness: card.harness, label: card.label, rows: card.rows.filter(row => row.state === "decide"), reason: card.notes[0] ?? null }));
}

export interface FlowFix {
  harness: InstallAgent;
  label: string;
  /** The rows the app cannot touch, each with why ("Base block markers are malformed…"). */
  rows: Array<{ label: string; reason: string | null }>;
}

/** The agents with something to fix by hand, in card order: rows the app leaves alone until the file is repaired. */
export function fixesOf(cards: readonly AgentCardModel[]): FlowFix[] {
  return cards
    .map(card => ({ harness: card.harness, label: card.label, rows: card.rows.filter(row => row.state === "fix").map(row => ({ label: row.label, reason: row.subline })) }))
    .filter(fix => fix.rows.length > 0);
}

/** Nothing is installed yet: every agent that is counted waits only for its first install. */
export function nothingInstalled(cards: readonly AgentCardModel[]): boolean {
  const judged = cards.filter(card => card.badge !== null && card.badge.state !== "off");
  return judged.length > 0 && judged.every(card => card.badge?.text === READY_TO_INSTALL_LABEL);
}

/* ---- the run ---- */

/** The folder each agent keeps its files in (`~/.claude`), as `harnessHomePath` reads it from the agent targets. */
export type HarnessHomes = Partial<Record<InstallAgent, string>>;

/** The agent a file of the run belongs to: the one whose folder is the longest prefix of it; null for a shared folder such as `~/.agents/skills`. */
export function agentForFile(file: string, homes: HarnessHomes): InstallAgent | null {
  let best: { agent: InstallAgent; length: number } | null = null;
  for (const agent of HARNESS_NAV_ORDER) {
    const home = homes[agent];
    if (!home) continue;
    if ((file === home || file.startsWith(`${home}/`)) && (!best || home.length > best.length)) best = { agent, length: home.length };
  }
  return best?.agent ?? null;
}

export interface RunTrace {
  /** The agent whose file is being written right now. */
  current: InstallAgent | null;
  /** The agents seen so far, in the order their first file came. */
  seen: InstallAgent[];
  /** Files written per agent so far. */
  counts: Partial<Record<InstallAgent, number>>;
  files: string[];
}

export const EMPTY_TRACE: RunTrace = { current: null, seen: [], counts: {}, files: [] };

/** One progress report of the run, folded into the trace. Only the apply phase names files that are being written. */
export function traceStep(trace: RunTrace, progress: Pick<ApplyProgress, "phase" | "file"> | null, homes: HarnessHomes): RunTrace {
  if (!progress || progress.phase === "backup") return trace.current === null ? trace : { ...trace, current: null };
  if (progress.phase === "done" || !progress.file) return trace.current === null ? trace : { ...trace, current: null };
  const agent = agentForFile(progress.file, homes);
  const isNew = !trace.files.includes(progress.file);
  if (!isNew && agent === trace.current) return trace;
  const counts = { ...trace.counts };
  if (agent && isNew) counts[agent] = (counts[agent] ?? 0) + 1;
  return {
    current: agent,
    seen: agent && !trace.seen.includes(agent) ? [...trace.seen, agent] : trace.seen,
    counts,
    files: isNew ? [...trace.files, progress.file] : trace.files,
  };
}

export interface ChecklistRow {
  agent: InstallAgent;
  label: string;
  state: "done" | "current" | "waiting";
  files: number;
}

/** The agents of a run, in order: those that were waiting for the run to start first, then any other the run reached. */
export function runChecklist(trace: RunTrace, startAgents: readonly InstallAgent[]): ChecklistRow[] {
  const order = [...new Set([...startAgents, ...trace.seen])];
  return order.map(agent => ({
    agent,
    label: HARNESS_LABELS[agent],
    state: agent === trace.current ? "current" : trace.seen.includes(agent) ? "done" : "waiting",
    files: trace.counts[agent] ?? 0,
  }));
}
