import type { InstallationOverview, OverviewEntry } from "../hooks/useInstallationOverview";
import type { AppSettings, InstallAgent, SecurityPosture, SetupSurfaceId, WorkspaceDiagnostics } from "../types";
import { HARNESS_LABELS, HARNESS_NAV_ORDER } from "./harnessInstallation";
import { runtimeVerdict, type HarnessRuntimeHealth } from "./harnessRuntimeRows";
import { surfaceRowsFor, surfaceShortName } from "./installationView";
import { riskyFindingPhrases } from "./securityPostureRows";
import { harnessUiItems } from "./shellSummary";
import {
  aggregateState,
  harnessBadge,
  overviewHeadline,
  runtimeSubline,
  summaryParts,
  surfaceUiState,
  tally,
  UI_STATE_PRECEDENCE,
  type UiItem,
  type UiState,
} from "./uiState";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/** What a state is called inside a card row (the pill and the summary row use the longer `UI_STATE_LABEL`). */
export const STATE_SHORT: Record<UiState, string> = {
  ok: "up to date",
  ready: "update ready",
  decide: "needs decision",
  yours: "yours",
  fix: "fix by hand",
  off: "not managed",
};

const ROW_LABEL: Record<string, string> = {
  rules: "Rules",
  agents: "Agents",
  skills: "Skills",
  config: "Settings",
  mcp: "MCP",
};

/** Rows of an agent card in reading order, whatever order the harness lists its surfaces in. */
const ROW_ORDER = ["rules", "agents", "skills", "config", "mcp"];

export interface CardRow {
  surface: SetupSurfaceId;
  label: string;
  /** Null while the row is not counted (loading, failed to check, needs the workspace folder). */
  state: UiState | null;
  /** The state in a word or two: "up to date", "not installed", "checking…". */
  text: string;
}

export interface AgentCardModel {
  harness: InstallAgent;
  label: string;
  /** The card's pill: its aggregate state; null while nothing in it is counted. */
  badge: { state: UiState; text: string } | null;
  rows: CardRow[];
  /** At most two lines under the rows: why the most urgent row is not up to date, and the runtime warning. */
  notes: string[];
}

function rowText(item: UiItem, notInstalled: boolean): string {
  if (item.state === null) return item.subline === "Checking…" ? "checking…" : "not checked";
  if (item.state === "ready" && notInstalled) return "not installed";
  return STATE_SHORT[item.state];
}

interface HarnessModel {
  card: AgentCardModel;
  items: UiItem[];
  /** Counted items that wait only because they were never installed. */
  allNotInstalled: boolean;
}

function harnessModel(input: {
  harness: InstallAgent;
  entry: OverviewEntry | undefined;
  settings: EnabledSettings;
  dataFolderOk: boolean;
  runtime?: HarnessRuntimeHealth | null;
}): HarnessModel {
  const { harness, entry, settings, dataFolderOk, runtime } = input;
  // Same order: `harnessUiItems` maps `surfaceRowsFor` one to one.
  const items = harnessUiItems(harness, entry, settings, dataFolderOk);
  const surfaceRows = surfaceRowsFor(harness, entry, settings);
  const notInstalled = items.map((_, index) => surfaceRows[index]?.state === "not_installed");

  const rows = items
    .map((item, index) => {
      const short = surfaceShortName(item.surface);
      return {
        short,
        row: { surface: item.surface, label: ROW_LABEL[short] ?? short, state: item.state, text: rowText(item, notInstalled[index]!) },
      };
    })
    .sort((a, b) => ROW_ORDER.indexOf(a.short) - ROW_ORDER.indexOf(b.short))
    .map(({ row }) => row);

  const notes: string[] = [];
  // The most urgent row's own sentence. Up to date and off rows say all there is to say in the row text; a row that is
  // not counted (a failed check, the folder) only explains itself once it is not merely loading.
  const rank = (item: UiItem) => (item.state ? UI_STATE_PRECEDENCE.indexOf(item.state) : UI_STATE_PRECEDENCE.length);
  const explained = items
    .filter(item => item.subline && item.state !== "off" && item.state !== "ok" && item.subline !== "Checking…")
    .sort((a, b) => rank(a) - rank(b))[0];
  if (explained?.subline) notes.push(explained.subline);
  const aggregate = aggregateState(items.map(item => item.state));
  const runtimeLine = runtime && dataFolderOk ? runtimeSubline(aggregate, runtimeVerdict(runtime)) : null;
  if (runtimeLine) notes.push(runtimeLine);

  // Rows that are off or not counted say nothing about whether the agent was ever set up.
  const counted = items
    .map((item, index) => ({ item, notInstalled: notInstalled[index]! }))
    .filter(({ item }) => item.state !== null && item.state !== "off");
  return {
    card: { harness, label: HARNESS_LABELS[harness], badge: harnessBadge(items), rows, notes },
    items,
    allNotInstalled: counted.length > 0 && counted.every(entry => entry.item.state === "ready" && entry.notInstalled),
  };
}

/**
 * The Overview card of one enabled agent: a pill for its aggregate state, one row per surface with its state in words,
 * and the sub-line of the most urgent row. Runtime health is never a row or a state; it only adds a sub-line when the
 * agent reads as up to date or ready (`runtimeSubline`).
 */
export function agentCardModel(input: {
  harness: InstallAgent;
  entry: OverviewEntry | undefined;
  settings: EnabledSettings;
  dataFolderOk: boolean;
  runtime?: HarnessRuntimeHealth | null;
}): AgentCardModel {
  return harnessModel(input).card;
}

export interface WorkspaceItemModel {
  item: UiItem;
  /** The workspace item's sub-line ("133 old copies to remove", why the folder is unusable). */
  subline: string | null;
}

/** The workspace folder as a counted item: `workspace_bundle`, which only ever removes old copies of the bundle. */
export function workspaceItemModel(input: {
  entry: OverviewEntry | undefined;
  settings: EnabledSettings | null;
  dataFolderOk: boolean;
  diagnostics: Pick<WorkspaceDiagnostics, "error"> | null;
}): WorkspaceItemModel {
  const { entry, settings, dataFolderOk, diagnostics } = input;
  const row = surfaceRowsFor("workspace", entry, settings)[0];
  const { state, subline } = surfaceUiState({
    display: row?.state ?? "unknown",
    surface: "workspace_bundle",
    detail: row?.detail,
    dataFolderOk,
    workspaceItem: true,
    workspaceError: diagnostics?.error ?? null,
    entryError: entry?.error,
  });
  return { item: { key: "workspace:workspace_bundle", owner: "workspace", surface: "workspace_bundle", state, subline }, subline };
}

export interface OverviewSummaryModel {
  headline: string;
  parts: Array<{ state: UiState; count: number; text: string }>;
  counts: Record<UiState, number>;
  /** Entries whose status could not be fetched; they are not counted and the summary row says so. */
  failedChecks: number;
  cards: AgentCardModel[];
  workspace: WorkspaceItemModel;
}

/** Everything the Overview header and cards show, computed from the overview and the settings. */
export function overviewSummaryModel(input: {
  overview: InstallationOverview;
  settings: EnabledSettings | null;
  enabledHarnessIds: readonly InstallAgent[];
  dataFolderOk: boolean;
  diagnostics: Pick<WorkspaceDiagnostics, "error"> | null;
  runtime?: Partial<Record<InstallAgent, HarnessRuntimeHealth | null>>;
}): OverviewSummaryModel {
  const { overview, settings, dataFolderOk, diagnostics, runtime } = input;
  const harnesses = HARNESS_NAV_ORDER.filter(harness => input.enabledHarnessIds.includes(harness));
  const workspace = workspaceItemModel({ entry: overview.entries.workspace, settings, dataFolderOk, diagnostics });
  const models = settings
    ? harnesses.map(harness =>
        harnessModel({ harness, entry: overview.entries[harness], settings, dataFolderOk, runtime: runtime?.[harness] ?? null }),
      )
    : [];
  const counts = tally([workspace.item, ...models.flatMap(model => model.items)]);

  const entries = Object.values(overview.entries).filter((entry): entry is OverviewEntry => entry !== undefined);
  // At least one agent was judged, and every one that was is waiting only for its first install.
  const judged = models.filter(model => model.items.some(item => item.state !== null && item.state !== "off"));
  const allNotInstalled = judged.length > 0 && judged.every(model => model.allNotInstalled);

  return {
    headline: overviewHeadline(counts, {
      dataFolderOk,
      anyStatus: entries.some(entry => entry.status !== null),
      allNotInstalled,
    }),
    parts: summaryParts(counts),
    counts,
    failedChecks: entries.filter(entry => entry.error).length,
    cards: models.map(model => model.card),
    workspace,
  };
}

export interface WorthALookRow {
  harness: InstallAgent;
  label: string;
  /** The first risky finding's phrase, plus "+ n more" when there are others. */
  text: string;
}

export interface WorthALook {
  /** Risky findings across the enabled agents. */
  count: number;
  rows: WorthALookRow[];
}

/** The risky posture findings of the enabled agents, one row per agent that has any. Advice and "set" never appear here. */
export function worthALook(
  postures: Partial<Record<InstallAgent, SecurityPosture | null>>,
  enabledHarnessIds: readonly InstallAgent[],
): WorthALook {
  const rows: WorthALookRow[] = [];
  let count = 0;
  for (const harness of HARNESS_NAV_ORDER) {
    if (!enabledHarnessIds.includes(harness)) continue;
    const posture = postures[harness];
    const phrases = posture ? riskyFindingPhrases(posture) : [];
    if (phrases.length === 0) continue;
    count += phrases.length;
    rows.push({
      harness,
      label: HARNESS_LABELS[harness],
      text: phrases.length > 1 ? `${phrases[0]} + ${phrases.length - 1} more` : phrases[0]!,
    });
  }
  return { count, rows };
}

/** The agents that are off, in sidebar order. */
export function disabledHarnesses(enabledHarnessIds: readonly InstallAgent[]): InstallAgent[] {
  return HARNESS_NAV_ORDER.filter(harness => !enabledHarnessIds.includes(harness));
}

/** "Cursor", "Cursor and Copilot", "Cursor, Copilot and Pi". */
export function listText(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
