import { useEffect, useState, type ReactNode } from "react";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { OutputPane } from "../components/OutputPane";
import { RulesPane } from "../components/RulesPane";
import { RulesSummary } from "../components/RulesSummary";
import { useRulesActions } from "../hooks/useRulesActions";
import { useRulesFlow } from "../hooks/useRulesFlow";
import { useKeymap } from "../keyboard/useKeymap";
import { HARNESS_LABELS } from "../lib/harnessInstallation";
import { runtimeRowsFor, runtimeVerdict, type HarnessRuntimeHealth } from "../lib/harnessRuntimeRows";
import {
  previewDisabledFor,
  surfaceRowsFor,
  targetMeta,
  updateActionFor,
} from "../lib/installationView";
import { rulesModelFor, rulesOverrideWarning, rulesSurfaceOf } from "../lib/rulesView";
import { filterTargetsForPage } from "../lib/targetGroups";
import { ActionKey } from "../ui/ActionKey";
import { Glyph } from "../ui/Glyph";
import { Kv } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import { PaneList } from "../ui/PaneList";
import { toneClass } from "../ui/tone";
import type { AgentTargetMeta, InstallAgent } from "../types";
import { installBindings } from "./installBindings";
import type { HarnessViewProps } from "./pageTypes";

export interface HarnessPageProps extends HarnessViewProps {
  harness: InstallAgent;
  /** What the harness syncs; shown under the targets. */
  summary: string;
  runtime: HarnessRuntimeHealth;
  /** Extra content after the runtime facts (OpenCode: the editable model override). */
  runtimeExtra?: ReactNode;
}

/**
 * One harness (Codex, OpenCode, Cursor, Claude) as four panes: [1] the targets it syncs (a multi-select list,
 * Space toggles and the change autosaves), [2] its surfaces and installation state, [3] runtime facts, [4]
 * output. Update and preview open the install review in place of the four panes; `d` and `v` on a rules file
 * open the rules review (a diff, or the preview of converting it) the same way.
 */
export function HarnessPage({
  harness,
  summary,
  runtime,
  runtimeExtra,
  appSettings,
  agentTargets,
  settingsSaveStatus,
  onToggleTarget,
  overview,
  install,
  backupRoot,
  rollbackTransactionId,
  onRollback,
  onRefresh,
  runWorkspaceTask,
  refreshAfterApply,
  onApplied,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onClearOutput,
}: HarnessPageProps) {
  const label = HARNESS_LABELS[harness];
  const entry = overview.entries[harness];
  const targets: AgentTargetMeta[] = filterTargetsForPage(agentTargets, harness);
  const enabledTargets = new Set(appSettings?.enabled_target_ids ?? []);
  const [targetCursor, setTargetCursor] = useState<string | null>(null);
  const saving = settingsSaveStatus === "saving" || settingsSaveStatus === "pending";

  const update = updateActionFor(harness, entry, { workspaceValid, busyLabel: wsRunning, settingsSaving: saving });
  const previewDisabled = previewDisabledFor(harness, { workspaceValid, busyLabel: wsRunning });

  const rulesSurface = rulesSurfaceOf(harness);
  const rulesModel = workspaceValid ? rulesModelFor(harness, entry?.status) : null;
  const rulesFlow = useRulesFlow({ runWorkspaceTask, refresh: refreshAfterApply, onApplied });
  const installOpen = install.isOpenOn(harness);
  const rules = useRulesActions({
    harness,
    model: rulesModel,
    workspaceValid,
    busyLabel: wsRunning,
    installOpen,
    flow: rulesFlow,
    paneIds: ["surfaces"],
    reload: () => overview.refresh(),
  });
  // `:update` can open the install review while a rules review is showing; the install review wins.
  useEffect(() => {
    if (installOpen) rulesFlow.close();
  }, [installOpen, rulesFlow.close]);

  useKeymap(
    installBindings({
      idPrefix: harness,
      paneIds: ["targets", "surfaces"],
      update,
      previewDisabled,
      onUpdate: () => void install.open(harness),
      onPreview: () => void install.open(harness, { readOnly: true }),
      onRefresh: () => void overview.refresh(),
    }),
    { enabled: !installOpen && !rulesFlow.open },
  );

  const outputPane = (index: number) => (
    <OutputPane
      index={index}
      wsRunning={wsRunning}
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

  if (installOpen) {
    return (
      <section className="screen install" aria-label={`${label} install review`}>
        <InstallPlanPane flow={install.flow} index={1} busyLabel={wsRunning} backupRoot={backupRoot} onApply={install.apply} />
        {outputPane(2)}
      </section>
    );
  }

  if (rulesFlow.open) {
    return (
      <section className="screen install" aria-label={`${label} rules review`}>
        <RulesPane
          flow={rulesFlow}
          index={1}
          busyLabel={wsRunning}
          backupRoot={backupRoot}
          canConvert={rulesModel?.convertible === true}
        />
        {outputPane(2)}
      </section>
    );
  }

  const surfaceRows = surfaceRowsFor(harness, entry, appSettings);
  const meta = targetMeta(entry, { workspaceValid, id: harness });
  const verdict = runtimeVerdict(runtime);
  const cursorTarget = targets.find(target => target.id === targetCursor) ?? targets[0];
  const enabledCount = targets.filter(target => enabledTargets.has(target.id)).length;
  const override = rulesOverrideWarning(runtime.harness === "codex" ? runtime.health : null);

  return (
    <section className="screen quad" aria-label={label}>
      <Pane
        id="targets"
        index={1}
        title="targets"
        label={`${label} targets`}
        defaultFocus
        meta={
          <>
            {`· ${enabledCount}/${targets.length} on`}
            {saving && <span className="c-dim"> · autosaving…</span>}
            {settingsSaveStatus === "error" && <span className="c-fail"> · not saved, retry in settings</span>}
          </>
        }
        footer={
          cursorTarget ? (
            <ActionKey keys={["Space"]} shortcut="Space" onClick={() => onToggleTarget(cursorTarget.id)}>
              toggle
            </ActionKey>
          ) : null
        }
      >
        {appSettings ? (
          <PaneList
            label={`${label} targets`}
            items={targets}
            getKey={target => target.id}
            getGroup={target => target.kind}
            cursorKey={cursorTarget?.id ?? null}
            onCursorChange={key => setTargetCursor(key)}
            selectedKeys={enabledTargets}
            multiSelectable
            onToggle={target => onToggleTarget(target.id)}
            empty="this harness has no targets"
            renderItem={target => (
              <>
                <span className="nm">
                  {enabledTargets.has(target.id) ? "[x]" : "[ ]"} {target.label}
                </span>
                <span className="meta" title={`${target.target_rel} ← ${target.source_rel}`}>
                  {target.target_rel}
                </span>
              </>
            )}
          />
        ) : (
          <p className="c-dim">loading settings…</p>
        )}
        <p className="c-dim pane-note">{summary}</p>
      </Pane>

      <Pane
        id="surfaces"
        index={2}
        title="surfaces"
        label={`${label} surfaces`}
        meta={
          <>
            {"· "}
            <span className={toneClass(meta.tone) || undefined}>{meta.text}</span>
          </>
        }
      >
        {!workspaceValid && (
          <p className="c-warn pane-note" role="status">
            No valid workspace installed. Install it on the workspace page first.
          </p>
        )}
        {override && (
          <p className="rules-alert" role="alert">
            <Glyph name="conflict" tone="warn" /> <b>{override.title}.</b> {override.detail}
          </p>
        )}
        <PaneList
          label={`${label} surfaces`}
          items={surfaceRows}
          getKey={row => row.surface}
          renderItem={row => {
            // A file the user keeps is not current and not a conflict; the rules model says so.
            const display = row.surface === rulesSurface && rulesModel?.display ? rulesModel.display : row.display;
            return (
              <>
                <span className="nm">
                  {row.name} {row.detail && <span className="c-dim">{row.detail}</span>}
                </span>
                <span className={`meta ${toneClass(display.tone)}`.trim()}>
                  <Glyph name={display.glyph} tone={display.tone} /> {display.label}
                </span>
              </>
            );
          }}
        />
        {rulesModel && <RulesSummary model={rulesModel} error={rules.error} />}
        {entry?.status && <p className="c-dim pane-note">{entry.status.summary}</p>}
        {entry?.error && (
          <p className="c-fail pane-note" role="status">
            status failed: {entry.error}
          </p>
        )}
        {entry?.status?.conflict_details && entry.status.conflict_details.length > 0 && (
          <p className="c-warn pane-note">Preserved: {entry.status.conflict_details.join(", ")}</p>
        )}
      </Pane>

      <Pane
        id="runtime"
        index={3}
        title="runtime"
        label={`${label} runtime`}
        scrollable
        meta={
          <>
            {"· "}
            <span className={toneClass(verdict.tone) || undefined}>{verdict.text}</span>
          </>
        }
      >
        <Kv items={workspaceValid ? runtimeRowsFor(runtime) : [{ label: "runtime", value: "no valid workspace", tone: "dim" }]} />
        {workspaceValid && runtimeExtra}
      </Pane>

      {outputPane(4)}
    </section>
  );
}
