import { useMemo } from "react";
import { AgentCell } from "../components/overview/AgentCell";
import { LastUpdateCell } from "../components/overview/LastUpdateCell";
import { MoreAgentsRow } from "../components/overview/MoreAgentsRow";
import { OverviewHeader } from "../components/overview/OverviewHeader";
import { WorkspaceFolderCell } from "../components/overview/WorkspaceFolderCell";
import { WorthALookCell } from "../components/overview/WorthALookCell";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { useFocusOutputOnNewTransaction } from "../components/OutputStrip";
import { RunPanel } from "../components/run/RunPanel";
import { useLastUpdate } from "../hooks/useLastUpdate";
import { usePostureOverview } from "../hooks/usePostureOverview";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import type { HarnessRuntimeHealth } from "../lib/harnessRuntimeRows";
import { previewDisabledFor } from "../lib/installationView";
import { disabledHarnesses, overviewSummaryModel, worthALook } from "../lib/overviewModel";
import { rulesOverrideWarning } from "../lib/rulesView";
import { updateAllDisabledReason } from "../lib/shellSummary";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type { AppView } from "../shell/views";
import { Page } from "../ui/Page";
import type { AppSettings, InstallAgent, WorkspaceDiagnostics } from "../types";
import { installBindings } from "./installBindings";
import type { PageInstallProps, PageOutputProps } from "./pageTypes";

export interface OverviewViewProps extends PageOutputProps, PageInstallProps {
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  appSettings: AppSettings | null;
  enabledHarnessIds: InstallAgent[];
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

/** Empty slots that finish the last row of agent cells in the three-column grid, so the hairlines still close it. */
function fillerCount(cards: number): number {
  return (3 - (cards % 3)) % 3;
}

/**
 * The first page: how the setup stands, in two lines (a short verdict, then the counts of the states that are not
 * zero), over a hairline grid with one cell per enabled agent, the receipt of the last update, anything worth a look
 * in the agents' security settings, the agents that are off, and the workspace folder (collapsed, with Uninstall).
 * Cells open the agent's page; nothing here writes. `u` opens the review of every update (Update all), `p` the
 * read-only preview of it, `r` checks again, `o` and `B` open the folders; the review replaces the page while it is
 * open and only `y` there applies it. The run panel sits at the bottom: progress while a task runs, then its outcome with Undo, Details and Dismiss.
 */
export function OverviewView({
  workspaceDiagnostics,
  appSettings,
  enabledHarnessIds,
  runtimeHealth,
  checkedAt = null,
  updateAllDisabled,
  onNavigate,
  overview,
  install,
  backupRoot,
  rollbackTransactionId,
  onRollback,
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
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  wsProgress,
  dataFolderOk,
  onClearOutput,
}: OverviewViewProps) {
  useFocusOutputOnNewTransaction(rollbackTransactionId);
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
  const lastUpdate = useLastUpdate({
    enabled: dataFolderOk,
    // A finished apply, uninstall or rollback changes the history; so does starting and ending a task.
    refreshKey: `${wsLogCompletedAt ?? 0}:${busy ? "run" : "idle"}`,
  });

  const updateDisabled =
    updateAllDisabled ?? updateAllDisabledReason(overview, { dataFolderOk, busyLabel: wsRunning, settingsSaving: false });
  const previewDisabled = previewDisabledFor("workspace", { dataFolderOk, busyLabel: wsRunning });

  const pageBindings: Binding[] = [
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

  const runPanel = (
    <RunPanel
      wsRunning={wsRunning}
      progress={wsProgress}
      wsLog={wsLog}
      wsLogCompletedAt={wsLogCompletedAt}
      onClear={onClearOutput}
      onRefresh={onRefresh}
      rollbackTransactionId={rollbackTransactionId}
      onRollback={onRollback}
    />
  );

  if (showPlan) {
    return (
      <section className="screen review" aria-label="Workspace install review">
        <InstallPlanPane flow={install.flow} busyLabel={wsRunning} backupRoot={backupRoot} onApply={install.apply} />
        {runPanel}
      </section>
    );
  }

  const openAgent = (harness: InstallAgent) => onNavigate(harness);
  const cards = summary.cards;
  const off = disabledHarnesses(enabledHarnessIds);
  const dataFolder =
    overview.entries.workspace?.status?.surfaces.find(row => row.surface === "workspace_bundle")?.data_folder ?? null;
  const codexRuntime = runtimeHealth?.codex;
  const codexOverride = rulesOverrideWarning(codexRuntime?.harness === "codex" ? codexRuntime.health : null);

  return (
    <div className="ov">
      <Page label="Overview" className="ov-page">
        <OverviewHeader summary={summary} checkedAt={checkedAt} />
        <div className="ov-grid">
          {cards.map(card => (
            <AgentCell key={card.harness} card={card} override={card.harness === "codex" ? codexOverride : null} onOpen={openAgent} />
          ))}
          {Array.from({ length: fillerCount(cards.length) }, (_, index) => (
            <div key={`fill-${index}`} className="ov-cell ov-fill" aria-hidden="true" />
          ))}
          {lastUpdate && (
            <LastUpdateCell
              entry={lastUpdate}
              backupCount={backupCount}
              span={look.count > 0 ? 2 : 3}
              undoDisabled={busy ? `${wsRunning} is running` : false}
              onUndo={onUndo}
            />
          )}
          <WorthALookCell look={look} span={lastUpdate ? 1 : 3} onOpen={openAgent} />
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
      <div className="ov-strip">{runPanel}</div>
    </div>
  );
}
