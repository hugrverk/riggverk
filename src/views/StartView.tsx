import { useState } from "react";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { OutputStrip, useFocusOutputOnNewTransaction } from "../components/OutputStrip";
import { SurfaceMatrix } from "../components/SurfaceMatrix";
import { completedLabel } from "../components/TerminalOutput";
import { UninstallCard } from "../components/UninstallCard";
import { UninstallRecoveryCard } from "../components/UninstallRecoveryCard";
import type { OverviewId } from "../hooks/useInstallationOverview";
import { focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { harnessForView } from "../lib/harnessInstallation";
import {
  matrixModel,
  overviewLabel,
  overviewTargets,
  previewDisabledFor,
  surfaceRowsFor,
  targetMeta,
  updateActionFor,
} from "../lib/installationView";
import { rulesModelFor, rulesOverrideWarning, rulesPageHint, rulesSurfaceOf } from "../lib/rulesView";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type { AppView } from "../shell/views";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import { PaneList } from "../ui/PaneList";
import { toneClass } from "../ui/tone";
import type { AppSettings, CodexRuntimeHealth, InstallAgent, WorkspaceDiagnostics } from "../types";
import { installBindings } from "./installBindings";
import type { PageInstallProps, PageOutputProps } from "./pageTypes";

export interface StartViewProps extends PageOutputProps, PageInstallProps {
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  appSettings: AppSettings | null;
  enabledHarnessIds: InstallAgent[];
  /** Codex runtime health, for the AGENTS.override.md warning. */
  codexRuntimeHealth?: CodexRuntimeHealth | null;
  /** Enter on a harness row opens its page. */
  onNavigate: (view: AppView) => void;
  onUninstall: (planFingerprint: string, previewToken: string) => void;
  uninstallRecoveryTransactionId: string | null;
  onUninstallRollback: () => Promise<boolean>;
  /** `:uninstall` asks for the preview dialog. */
  uninstallPreviewRequested: boolean;
  onUninstallPreviewHandled: () => void;
  onOpenFolder: () => void;
  onReleaseCheck: () => void;
  backupCount: number;
  onOpenBackupsFolder: () => void;
}

/**
 * The workspace page, master-detail: [1] the workspace and the enabled harnesses with their installation state
 * and the installed-state matrix, [2] the detail of the one under the cursor (surfaces, status, verification, the
 * uninstall and recovery actions), and the output strip under both. `u` and `p` open the install review in
 * place of the panes.
 */
export function StartView({
  workspaceDiagnostics,
  appSettings,
  enabledHarnessIds,
  codexRuntimeHealth = null,
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
  onReleaseCheck,
  backupCount,
  onOpenBackupsFolder,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  wsProgress,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onClearOutput,
}: StartViewProps) {
  useFocusOutputOnNewTransaction(rollbackTransactionId);
  const targets = overviewTargets(enabledHarnessIds);
  const [cursor, setCursor] = useState<OverviewId>("workspace");
  const selected: OverviewId = targets.includes(cursor) ? cursor : "workspace";
  const entry = overview.entries[selected];
  const busy = wsRunning !== null;
  const resolvedPath =
    workspaceDiagnostics?.resolved_path ?? workspaceDiagnostics?.candidate_path ?? DEFAULT_WORKSPACE_PATH;

  const update = updateActionFor(selected, entry, { workspaceValid, busyLabel: wsRunning, settingsSaving: false });
  const previewDisabled = previewDisabledFor(selected, { workspaceValid, busyLabel: wsRunning });
  const showPlan = install.isOpenOn("start");

  const releaseCheckState = !workspaceValid
    ? false
    : busy
      ? `${wsRunning} is running`
      : canRunReleaseCheck
        ? true
        : "release-check is not available in this workspace";
  const statusBindings: Binding[] = [
    {
      id: "start.detail.release-check",
      keys: "R",
      title: "Run the release check",
      hint: "release-check",
      group: "Verify",
      scope: "pane",
      paneId: "detail",
      when: () => releaseCheckState,
      run: () => onReleaseCheck(),
    },
    {
      id: "start.detail.open-folder",
      keys: "o",
      title: "Open the workspace folder",
      hint: "open folder",
      group: "Verify",
      scope: "pane",
      paneId: "detail",
      when: () => (!workspaceValid ? false : busy ? `${wsRunning} is running` : true),
      run: () => onOpenFolder(),
    },
    {
      id: "start.detail.backups",
      keys: "B",
      title: "Open the backups folder",
      hint: "backups",
      group: "Verify",
      scope: "pane",
      paneId: "detail",
      when: () => (busy ? `${wsRunning} is running` : true),
      run: () => onOpenBackupsFolder(),
    },
  ];
  useKeymap(
    [
      ...installBindings({
        idPrefix: "start",
        paneIds: ["harnesses", "detail"],
        update,
        previewDisabled,
        // The review of the harness under the cursor stays on this page.
        onUpdate: () => void install.open(selected, { scope: "start" }),
        onPreview: () => void install.open(selected, { readOnly: true, scope: "start" }),
        onRefresh: () => void onRefresh(),
      }),
      ...statusBindings,
    ],
    { enabled: !showPlan },
  );

  const outputStrip = (
    <OutputStrip
      wsRunning={wsRunning}
      progress={wsProgress}
      wsLog={wsLog}
      wsLogCompletedAt={wsLogCompletedAt}
      status={status}
      workspaceValid={workspaceValid}
      gitAvailable={gitAvailable}
      canRunReleaseCheck={canRunReleaseCheck}
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
        {outputStrip}
      </section>
    );
  }

  const selectedLabel = overviewLabel(selected);
  const surfaceRows = surfaceRowsFor(selected, entry, appSettings);
  const meta = targetMeta(entry, { workspaceValid, id: selected });
  const conflicts = entry?.status?.conflict_details ?? [];
  // The rules file of the harness under the cursor: its state is told here, the actions live on the harness page.
  const rulesSurface = selected === "workspace" ? null : rulesSurfaceOf(selected);
  const rulesModel = selected === "workspace" || !workspaceValid ? null : rulesModelFor(selected, entry?.status);
  const rulesHint = rulesModel ? rulesPageHint(rulesModel, selectedLabel) : null;
  const override = selected === "codex" ? rulesOverrideWarning(codexRuntimeHealth) : null;

  // The state is the detail title's. The backend summary adds something only for an update: the breakdown.
  const changes = entry?.status?.state === "update_available" ? entry.status.summary.replace(/^Update available:\s*/, "") : null;
  const statusItems: KvItem[] = [
    ...(changes ? [{ label: "changes", value: changes, wrap: true }] : []),
    ...(entry?.error ? [{ label: "error", value: entry.error, tone: "fail" as const, wrap: true }] : []),
    ...(conflicts.length > 0
      ? [{ label: "preserved", value: conflicts.join(", "), tone: "warn" as const, wrap: true }]
      : []),
    ...(rulesModel
      ? [
          { label: "rules", value: `${rulesModel.headline} · ${rulesModel.refinements === "none" ? "no refinements" : rulesModel.refinements}`, tone: rulesModel.tone, wrap: true },
          ...(rulesModel.reason ? [{ label: "why", value: rulesModel.reason, tone: "dim" as const, wrap: true }] : []),
          ...(rulesHint ? [{ label: "", value: rulesHint, tone: "dim" as const, wrap: true, id: "rules-hint" }] : []),
        ]
      : []),
    // A harness's surfaces, on and off, are the rows right above.
    ...(selected === "workspace" ? [{ label: "path", value: resolvedPath, wrap: true }] : []),
  ];

  const lastCheck = wsLog?.action === "release_check" ? wsLog : null;
  const verifyItems: KvItem[] = [
    {
      label: "release-check",
      value: lastCheck
        ? `${lastCheck.success ? "ok" : "failed"}${wsLogCompletedAt ? ` · ${completedLabel(wsLogCompletedAt)}` : ""}`
        : canRunReleaseCheck
          ? "not run this session"
          : "not available",
      tone: lastCheck ? (lastCheck.success ? "ok" : "fail") : "dim",
    },
    {
      label: "backups",
      value: `${backupCount} run${backupCount === 1 ? "" : "s"}${backupRoot ? ` · ${backupRoot}` : ""}`,
      tone: backupCount > 0 ? undefined : "dim",
      wrap: true,
    },
    {
      label: "last tx",
      value: rollbackTransactionId ? `${rollbackTransactionId} · rollback available` : "none this session",
      tone: rollbackTransactionId ? "ok" : "dim",
      wrap: true,
    },
  ];

  return (
    <section className="screen pair" aria-label="Workspace">
      <Pane id="harnesses" title="harnesses" label="Harnesses" defaultFocus meta={`· ${targets.length}`}>
        <PaneList
          label="Harnesses"
          items={targets}
          getKey={id => id}
          cursorKey={selected}
          onCursorChange={key => setCursor(key as OverviewId)}
          activateHint="open"
          onActivate={id => {
            const harness = harnessForView(id);
            if (harness) onNavigate(harness);
            else focusPaneById("detail");
          }}
          renderItem={id => {
            const row = targetMeta(overview.entries[id], { workspaceValid, id });
            return (
              <>
                <span className="nm">{overviewLabel(id)}</span>
                <span className={`meta ${toneClass(row.tone)}`.trim()}>{row.text}</span>
              </>
            );
          }}
        />
        <div className="group pane-group">installed map</div>
        <SurfaceMatrix rows={matrixModel(overview, targets, appSettings)} selectedId={selected} />
      </Pane>

      <Pane
        id="detail"
        title={selectedLabel}
        label={`${selectedLabel} detail`}
        scrollable
        meta={
          <>
            · <span className={toneClass(meta.tone)}>{meta.text}</span>
          </>
        }
      >
        {override && (
          <p className="rules-alert" role="alert">
            <Glyph name="conflict" tone="warn" /> <b>{override.title}.</b> {override.detail}
          </p>
        )}
        <div className="group pane-group">surfaces</div>
        {/* Static rows, not a listbox: the detail is one scroll and j/k do not move inside it. */}
        <ul className="rows rows-static" aria-label={`${selectedLabel} surfaces`}>
          {surfaceRows.map(row => {
            // A rules file the user keeps is not current and not a conflict; the rules model says so. Its own
            // sentence is the `rules` / `why` rows below, so the row does not repeat it.
            const isRules = row.surface === rulesSurface && rulesModel !== null;
            const display = isRules && rulesModel.display ? rulesModel.display : row.display;
            return (
              <li key={row.surface} className="row">
                <span className="cur" aria-hidden="true" />
                <span className="nm">
                  {row.name} {row.detail && !isRules && <span className="c-dim">{row.detail}</span>}
                </span>
                <span className={`meta ${toneClass(display.tone)}`.trim()}>{display.label}</span>
              </li>
            );
          })}
        </ul>
        {/* The title already states the state; the group exists only when there is something to add to it. */}
        {statusItems.length > 0 && (
          <>
            <div className="group pane-group">status</div>
            <Kv items={statusItems} aria-label={`${selectedLabel} status`} />
          </>
        )}
        <div className="group pane-group">verify</div>
        <Kv items={verifyItems} aria-label="Verification and backups" />
        {(workspaceValid || uninstallRecoveryTransactionId) && (
          <>
            <div className="group pane-group">lifecycle</div>
            <UninstallCard
              workspaceValid={workspaceValid}
              busy={busy}
              onApply={onUninstall}
              previewRequested={uninstallPreviewRequested}
              onPreviewRequestHandled={onUninstallPreviewHandled}
            />
            <UninstallRecoveryCard
              transactionId={uninstallRecoveryTransactionId}
              busy={busy}
              onRollback={onUninstallRollback}
            />
          </>
        )}
      </Pane>

      {outputStrip}
    </section>
  );
}
