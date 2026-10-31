import { useMemo, useState } from "react";
import { FlowInspector } from "../components/overview/FlowInspector";
import { FlowMap } from "../components/overview/FlowMap";
import { MoreAgentsRow } from "../components/overview/MoreAgentsRow";
import { OverviewHeader } from "../components/overview/OverviewHeader";
import { WorkspaceFolderCell } from "../components/overview/WorkspaceFolderCell";
import { WorthALookCell } from "../components/overview/WorthALookCell";
import { useFlowRoom } from "../components/overview/useFlowRoom";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { useFlowSources } from "../hooks/useFlowSources";
import { useLastUpdate } from "../hooks/useLastUpdate";
import { usePostureOverview } from "../hooks/usePostureOverview";
import { useRunTrace } from "../hooks/useRunTrace";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { offRowsFit } from "../lib/flowLayout";
import { buildFlowModel, decisionsOf, expandOffGroup, fixesOf, nothingInstalled, sameRef, type FlowRef, type HarnessHomes } from "../lib/flowModel";
import { harnessHomePath } from "../lib/harnessHeader";
import { HARNESS_NAV_ORDER } from "../lib/harnessInstallation";
import type { HarnessRuntimeHealth } from "../lib/harnessRuntimeRows";
import { previewDisabledFor } from "../lib/installationView";
import { disabledHarnesses, overviewSummaryModel, worthALook } from "../lib/overviewModel";
import { rulesOverrideWarning } from "../lib/rulesView";
import { updateAllDisabledReason } from "../lib/shellSummary";
import type { SavedSelection } from "../hooks/useAppSettingsController";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type { AppView } from "../shell/views";
import { Page } from "../ui/Page";
import type { AgentTargetMeta, AppSettings, InstallAgent, WorkspaceDiagnostics } from "../types";
import { installBindings } from "./installBindings";
import type { PageInstallProps, PageOutputProps } from "./pageTypes";

export interface OverviewViewProps extends PageOutputProps, PageInstallProps {
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  appSettings: AppSettings | null;
  enabledHarnessIds: InstallAgent[];
  /** The toggles as the backend last acknowledged them; the flow sources are read for these, not for an edit waiting for its autosave. */
  savedSelection?: SavedSelection | null;
  /** The agents' targets: where each agent keeps its files, so the map can tell whose file a running task is writing. */
  agentTargets?: readonly AgentTargetMeta[];
  /** Runtime health per enabled agent: the Codex AGENTS.override.md warning and the runtime sub-lines. */
  runtimeHealth?: Partial<Record<InstallAgent, HarnessRuntimeHealth>>;
  /** When the installation status was last fetched. */
  checkedAt?: Date | null;
  /** Why Update all (`u`) cannot run, or false. Defaults to what the overview alone tells. */
  updateAllDisabled?: string | false;
  /** A cell or a link opens a page. */
  onNavigate: (view: AppView) => void;
  onUninstall: (planFingerprint: string, previewToken: string) => void;
  uninstallRecoveryTransactionId: string | null;
  onUninstallRollback: () => Promise<boolean>;
  /** `:uninstall` asks for the preview dialog. */
  uninstallPreviewRequested: boolean;
  onUninstallPreviewHandled: () => void;
  onOpenFolder: () => void;
  backupCount: number;
  onOpenBackupsFolder: () => void;
  /** Undo the update of a history entry: a dry run, a confirm, then the rollback. */
  onUndo: (transactionId: string) => void;
}

/**
 * The first page: how the setup stands, in two lines (a short verdict, then the counts of the states that are not
 * zero), over a flow map beside an inspector: sources (Riggverk base, your refinements, one node per skill pack) on the
 * left, the agents on the right, a curve for what flows between them. Selecting a node or a curve fills the inspector
 * (its rows, receipt and actions); with nothing selected it holds the verdict, any decision, Install everything on a
 * fresh profile and the receipt of the last update with Undo; while a task runs it follows the run, and the map marks
 * the agent being written. Below the map sit anything worth a look in the agents' security settings, the agents that
 * are off, and the workspace folder (collapsed, with Uninstall). Nothing here writes. `u` opens the review of every
 * update (Update all), `p` the read-only preview of it, `r` checks again, `o` and `B` open the folders, Esc clears the
 * selection; the review replaces the page while it is open and only `y` there applies it. The run panel sits at the
 * bottom: progress while a task runs, then its outcome with Undo, Details and Dismiss.
 */
export function OverviewView({
  workspaceDiagnostics,
  appSettings,
  enabledHarnessIds,
  savedSelection,
  agentTargets = [],
  runtimeHealth,
  checkedAt = null,
  updateAllDisabled,
  onNavigate,
  overview,
  install,
  backupRoot,
  rollbackTransactionId,
  onRefresh,
  onUninstall,
  uninstallRecoveryTransactionId,
  onUninstallRollback,
  uninstallPreviewRequested,
  onUninstallPreviewHandled,
  onOpenFolder,
  backupCount,
  onOpenBackupsFolder,
  onUndo,
  wsLogCompletedAt,
  wsRunning,
  wsProgress,
  dataFolderOk,
}: OverviewViewProps) {
  const busy = wsRunning !== null;
  const showPlan = install.isOpenOn("start");
  const resolvedPath =
    workspaceDiagnostics?.resolved_path ?? workspaceDiagnostics?.candidate_path ?? DEFAULT_WORKSPACE_PATH;

  const summary = useMemo(
    () =>
      overviewSummaryModel({
        overview,
        settings: appSettings,
        enabledHarnessIds,
        dataFolderOk,
        diagnostics: workspaceDiagnostics,
        runtime: runtimeHealth,
      }),
    [overview, appSettings, enabledHarnessIds, dataFolderOk, workspaceDiagnostics, runtimeHealth],
  );
  const postures = usePostureOverview(enabledHarnessIds, checkedAt?.getTime() ?? 0);
  const look = useMemo(() => worthALook(postures, enabledHarnessIds), [postures, enabledHarnessIds]);
  // A finished apply, uninstall or rollback changes the history; so does starting and ending a task.
  const refreshKey = `${wsLogCompletedAt ?? 0}:${busy ? "run" : "idle"}`;
  const lastUpdate = useLastUpdate({ enabled: dataFolderOk, refreshKey });
  const flowSources = useFlowSources({
    enabled: dataFolderOk,
    refreshKey,
    scopeKey: `${(savedSelection?.harnessIds ?? enabledHarnessIds).join(",")}|${(savedSelection?.targetIds ?? appSettings?.enabled_target_ids ?? []).join(",")}`,
  });
  const dataFolder =
    overview.entries.workspace?.status?.surfaces.find(row => row.surface === "workspace_bundle")?.data_folder ?? null;
  const built = useMemo(
    () => buildFlowModel({ cards: summary.cards, sources: flowSources, personalDocs: dataFolder?.personal_docs ?? null, lastUpdate }),
    [summary.cards, flowSources, dataFolder?.personal_docs, lastUpdate],
  );
  // With the height for it, the agents that are off get rows of their own; the map and the inspector share that model.
  const { room, pageRef, flowRef } = useFlowRoom();
  const expanded = offRowsFit(built, room);
  const flow = useMemo(() => (expanded ? expandOffGroup(built) : built), [built, expanded]);
  const homes = useMemo(() => {
    const found: HarnessHomes = {};
    for (const harness of HARNESS_NAV_ORDER) {
      const home = harnessHomePath(agentTargets, harness);
      if (home) found[harness] = home;
    }
    return found;
  }, [agentTargets]);
  const waiting = useMemo(() => summary.cards.filter(card => card.badge?.state === "ready").map(card => card.harness), [summary.cards]);
  const { trace, startAgents } = useRunTrace(wsRunning, wsProgress, homes, waiting);
  const [selected, setSelected] = useState<FlowRef | null>(null);
  // While a task runs the inspector follows it; a click then changes nothing.
  const select = (ref: FlowRef) => {
    if (busy) return;
    setSelected(previous => (sameRef(previous, ref) ? null : ref));
  };

  const updateDisabled =
    updateAllDisabled ?? updateAllDisabledReason(overview, { dataFolderOk, busyLabel: wsRunning, settingsSaving: false });
  const previewDisabled = previewDisabledFor("workspace", { dataFolderOk, busyLabel: wsRunning });

  const pageBindings: Binding[] = [
    {
      id: "start.flow.clear",
      keys: "Escape",
      title: "Clear the selection on the map",
      group: "Workspace",
      scope: "pane",
      paneId: "page",
      // Inactive with nothing selected, so Escape falls through to the global one (dismiss the error line).
      when: () => selected !== null,
      run: () => setSelected(null),
    },
    {
      id: "start.page.open-folder",
      keys: "o",
      title: "Open the workspace folder",
      hint: "open folder",
      group: "Verify",
      scope: "pane",
      paneId: "page",
      when: () => (!dataFolderOk ? false : busy ? `${wsRunning} is running` : true),
      run: () => onOpenFolder(),
    },
    {
      id: "start.page.backups",
      keys: "B",
      title: "Open the backups folder",
      hint: "backups",
      group: "Verify",
      scope: "pane",
      paneId: "page",
      when: () => (busy ? `${wsRunning} is running` : true),
      run: () => onOpenBackupsFolder(),
    },
  ];
  useKeymap(
    [
      ...installBindings({
        idPrefix: "start",
        paneIds: ["page"],
        update: { label: "update all", disabled: updateDisabled },
        previewDisabled,
        // Update all: the review of every enabled surface stays on this page.
        onUpdate: () => void install.open("all", { scope: "start" }),
        onPreview: () => void install.open("all", { readOnly: true, scope: "start" }),
        onRefresh: () => void onRefresh(),
      }),
      ...pageBindings,
    ],
    { enabled: !showPlan },
  );

  if (showPlan) {
    return (
      <section className="screen review" aria-label="Workspace install review">
        <InstallPlanPane flow={install.flow} busyLabel={wsRunning} backupRoot={backupRoot} onApply={install.apply} />
      </section>
    );
  }

  const openAgent = (harness: InstallAgent) => onNavigate(harness);
  const off = disabledHarnesses(enabledHarnessIds);
  const codexRuntime = runtimeHealth?.codex;
  const codexOverride = rulesOverrideWarning(codexRuntime?.harness === "codex" ? codexRuntime.health : null);

  return (
    <div className="ov">
      <Page label="Overview" className="ov-page" ref={pageRef}>
        <OverviewHeader summary={summary} checkedAt={checkedAt} />
        <div className="ov-flow" ref={flowRef}>
          <FlowMap
            model={flow}
            selected={selected}
            onSelect={select}
            live={busy ? trace.current : null}
            liveFiles={trace.current ? (trace.counts[trace.current] ?? 0) : 0}
            room={room}
          />
          <FlowInspector
            model={flow}
            selected={selected}
            counts={summary.counts}
            installing={nothingInstalled(summary.cards)}
            decisions={decisionsOf(summary.cards)}
            fixes={fixesOf(summary.cards)}
            lastUpdate={lastUpdate}
            backupCount={backupCount}
            run={busy ? { label: wsRunning, progress: wsProgress, trace, startAgents } : null}
            codexOverride={codexOverride}
            installDisabled={updateDisabled}
            onInstall={() => void install.open("all", { scope: "start" })}
            undoDisabled={busy ? `${wsRunning} is running` : false}
            onUndo={onUndo}
            onNavigate={onNavigate}
          />
        </div>
        <div className="ov-grid">
          <WorthALookCell look={look} span={3} onOpen={openAgent} />
          <MoreAgentsRow disabled={off} onAdd={() => onNavigate("settings")} />
          <WorkspaceFolderCell
            workspace={summary.workspace}
            path={resolvedPath}
            diagnostics={workspaceDiagnostics}
            dataFolderOk={dataFolderOk}
            dataFolder={dataFolder}
            backupCount={backupCount}
            backupRoot={backupRoot}
            rollbackTransactionId={rollbackTransactionId}
            wsRunning={wsRunning}
            onOpenFolder={onOpenFolder}
            onOpenBackupsFolder={onOpenBackupsFolder}
            onUninstall={onUninstall}
            uninstallRecoveryTransactionId={uninstallRecoveryTransactionId}
            onUninstallRollback={onUninstallRollback}
            uninstallPreviewRequested={uninstallPreviewRequested}
            onUninstallPreviewHandled={onUninstallPreviewHandled}
          />
        </div>
      </Page>
    </div>
  );
}
