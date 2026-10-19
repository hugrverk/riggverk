import { useEffect, useState, type ReactNode } from "react";
import { ConflictPane } from "../components/ConflictPane";
import { FileConflictSummary } from "../components/FileConflictSummary";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { OutputStrip, useFocusOutputOnNewTransaction } from "../components/OutputStrip";
import { RulesPane } from "../components/RulesPane";
import { RulesSummary } from "../components/RulesSummary";
import { useFileConflictActions } from "../hooks/useFileConflictActions";
import { useFileConflictFlow } from "../hooks/useFileConflictFlow";
import { useRulesActions } from "../hooks/useRulesActions";
import { useRulesFlow } from "../hooks/useRulesFlow";
import { useKeymap } from "../keyboard/useKeymap";
import {
  fileConflictModelFor,
  filesSurfacesOf,
  isFilesSurface,
  withFileConflicts,
  type FileConflictModel,
} from "../lib/fileConflicts";
import { HARNESS_LABELS } from "../lib/harnessInstallation";
import { runtimeRowsFor, runtimeVerdict, type HarnessRuntimeHealth } from "../lib/harnessRuntimeRows";
import {
  harnessRowsFor,
  previewDisabledFor,
  surfaceShortName,
  targetMeta,
  updateActionFor,
  WORKSPACE_FOLDER_UNUSABLE,
  type HarnessRowModel,
  type StateDisplay,
} from "../lib/installationView";
import { rulesModelFor, rulesOverrideWarning, rulesSurfaceOf } from "../lib/rulesView";
import {
  skillLoadProblemCount,
  skillLoadRows,
  skillReadsRows,
  summarizeSkillLoads,
  withSkillProblems,
} from "../lib/skillLoadRows";
import { useNotify } from "../shell/ShellState";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import { PaneList } from "../ui/PaneList";
import { RollingText } from "../ui/RollingText";
import { toneClass } from "../ui/tone";
import type { InstallAgent } from "../types";
import { installBindings } from "./installBindings";
import type { HarnessViewProps } from "./pageTypes";

export interface HarnessPageProps extends HarnessViewProps {
  harness: InstallAgent;
  runtime: HarnessRuntimeHealth;
  /** Extra content after the runtime facts (OpenCode: the editable model override). */
  runtimeExtra?: ReactNode;
}

/** An ungated row (skills) has no checkbox; three non-breaking spaces, as wide as `[x]`, keep its name in line. */
const NO_TOGGLE = "\u00a0\u00a0\u00a0";

/**
 * One harness (Codex, OpenCode, Cursor, Claude) as a master-detail pair: [1] one row per surface, each with the
 * toggle of the target that gates it (Space toggles, the change autosaves), [2] the detail of the row under the
 * cursor and the harness's runtime facts, then the output strip. Update and preview open the install review in
 * place of the pair; `d` and `v` on the rules row open the rules review (a diff, or the preview of converting
 * it) the same way, and `d` or `b` on a skills or agents row with files in conflict opens the conflict review (a
 * diff, or the preview of taking the bundled version).
 */
export function HarnessPage({
  harness,
  runtime,
  runtimeExtra,
  appSettings,
  skillLoads,
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
  wsProgress,
  status,
  workspaceValid,
  gitAvailable,
  onClearOutput,
}: HarnessPageProps) {
  const label = HARNESS_LABELS[harness];
  const notify = useNotify();
  useFocusOutputOnNewTransaction(rollbackTransactionId);
  const entry = overview.entries[harness];
  const [cursor, setCursor] = useState<string | null>(null);
  const [markedKey, setMarkedKey] = useState<string | null>(null);
  const saving = settingsSaveStatus === "saving" || settingsSaveStatus === "pending";

  const update = updateActionFor(harness, entry, { workspaceValid, busyLabel: wsRunning, settingsSaving: saving });
  const previewDisabled = previewDisabledFor(harness, { workspaceValid, busyLabel: wsRunning });

  const rows = appSettings ? harnessRowsFor(harness, entry, appSettings, agentTargets) : [];
  const selected = rows.find(row => row.surface === cursor) ?? rows[0] ?? null;

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
    paneIds: ["surfaces", "detail"],
    // d, v and m act on the rules file: offered only while the cursor is on it.
    active: rulesSurface !== null && selected?.surface === rulesSurface,
    reload: () => overview.refresh(),
  });
  // `:update` can open the install review while a rules review is showing; the install review wins.
  useEffect(() => {
    if (installOpen) rulesFlow.close();
  }, [installOpen, rulesFlow.close]);

  // Skill and agent files in conflict, or kept: c, d and m act on them while the cursor is on their row.
  const conflictFlow = useFileConflictFlow({ runWorkspaceTask, refresh: refreshAfterApply, onApplied });
  const fileModels = workspaceValid
    ? filesSurfacesOf(harness).flatMap((surface): FileConflictModel[] => {
        const model = fileConflictModelFor(entry?.status, surface);
        return model ? [model] : [];
      })
    : [];
  const activeModel = fileModels.find(model => model.surface === selected?.surface) ?? null;
  const files = useFileConflictActions({
    harness,
    models: fileModels,
    activeSurface: activeModel?.surface ?? null,
    workspaceValid,
    busyLabel: wsRunning,
    installOpen,
    rulesOpen: rulesFlow.open,
    flow: conflictFlow,
    paneIds: ["surfaces", "detail"],
    markedKey,
    onMark: setMarkedKey,
    // The kept flag of a skill copy shows in the skill loads too.
    reload: async () => {
      await Promise.all([overview.refresh(), skillLoads.refresh()]);
    },
  });
  // Another review opening closes the conflict review; the install and rules reviews win.
  useEffect(() => {
    if (installOpen || rulesFlow.open) conflictFlow.close();
  }, [installOpen, rulesFlow.open, conflictFlow.close]);

  useKeymap(
    installBindings({
      idPrefix: harness,
      paneIds: ["surfaces", "detail"],
      update,
      previewDisabled,
      onUpdate: () => void install.open(harness),
      onPreview: () => void install.open(harness, { readOnly: true }),
      onRefresh: () => void overview.refresh(),
    }),
    { enabled: !installOpen && !rulesFlow.open && !conflictFlow.open },
  );

  const outputStrip = () => (
    <OutputStrip
      wsRunning={wsRunning}
      progress={wsProgress}
      wsLog={wsLog}
      wsLogCompletedAt={wsLogCompletedAt}
      status={status}
      workspaceValid={workspaceValid}
      gitAvailable={gitAvailable}
      onClear={onClearOutput}
      onRefresh={onRefresh}
      rollbackTransactionId={rollbackTransactionId}
      onRollback={onRollback}
    />
  );

  if (installOpen) {
    return (
      <section className="screen review" aria-label={`${label} install review`}>
        <InstallPlanPane flow={install.flow} busyLabel={wsRunning} backupRoot={backupRoot} onApply={install.apply} />
        {outputStrip()}
      </section>
    );
  }

  if (rulesFlow.open) {
    return (
      <section className="screen review" aria-label={`${label} rules review`}>
        <RulesPane
          flow={rulesFlow}
          busyLabel={wsRunning}
          backupRoot={backupRoot}
          canConvert={rulesModel?.convertible === true}
        />
        {outputStrip()}
      </section>
    );
  }

  const conflictReview = conflictFlow.state;
  if (conflictReview.status !== "idle") {
    const reviewed = fileModels.find(model => model.surface === conflictReview.surface);
    return (
      <section className="screen review" aria-label={`${label} conflict review`}>
        <ConflictPane
          flow={conflictFlow}
          units={reviewed?.units ?? []}
          onMark={setMarkedKey}
          onToggleKept={files.toggleKept}
          busyLabel={wsRunning}
          backupRoot={backupRoot}
        />
        {outputStrip()}
      </section>
    );
  }

  const harnessState = targetMeta(entry, { workspaceValid, id: harness });
  // With an unusable workspace folder there is no runtime to judge: the heading says so and no rows follow.
  const verdict = workspaceValid ? runtimeVerdict(runtime) : { text: WORKSPACE_FOLDER_UNUSABLE, tone: "dim" as const };
  const override = rulesOverrideWarning(runtime.harness === "codex" ? runtime.health : null);
  const conflictDetails = entry?.status?.conflict_details ?? [];

  // Names the harness loads from several folders: the skills row says how many, whatever its install state.
  const skillProblems = skillLoadProblemCount(summarizeSkillLoads(skillLoads.loads, harness));
  // A file the user keeps is not current and not a conflict; the rules model says so.
  const displayOf = (row: HarnessRowModel): StateDisplay => {
    if (row.surface === rulesSurface && rulesModel?.display) return rulesModel.display;
    const base = row.surface === "skills" && row.state !== "off" ? withSkillProblems(row.display, skillProblems) : row.display;
    // Files in conflict or kept are told on their row: "update · 2 conflicts", "current · you manage 1".
    return isFilesSurface(row.surface) ? withFileConflicts(base, fileModels.find(model => model.surface === row.surface) ?? null) : base;
  };
  const selectedDisplay = selected ? displayOf(selected) : null;
  const showRules = rulesModel !== null && selected?.surface === rulesSurface;
  // What is true of the whole harness follows the surface's own facts, so one column of labels carries both.
  const facts: KvItem[] = [
    // The state is the detail title's; the facts are what the title cannot say.
    ...(selected ? surfaceFacts(selected, !showRules) : []),
    ...(selected?.surface === "skills" ? skillReadsRows(skillLoads, harness) : []),
    ...(entry?.error ? [{ label: "status", value: `failed: ${entry.error}`, tone: "fail" as const, wrap: true }] : []),
    // The files in conflict have their own lines below; this list would name every one of them.
    ...(conflictDetails.length > 0 && !activeModel ? [{ label: "preserved", value: conflictDetails.join(", "), tone: "warn" as const, wrap: true }] : []),
  ];

  const onToggle = (row: HarnessRowModel) => {
    if (row.targetId) onToggleTarget(row.targetId);
    else notify(`${row.name} have no target toggle`, { tone: "warn" });
  };

  return (
    <section className="screen pair" aria-label={label}>
      <Pane
        id="surfaces"
        title="surfaces"
        label={`${label} surfaces`}
        defaultFocus
        meta={
          <>
            {"· "}
            <RollingText key={harness} className={toneClass(harnessState.tone)}>{harnessState.text}</RollingText>
            {saving && <span className="c-dim"> · autosaving…</span>}
            {settingsSaveStatus === "error" && <span className="c-fail"> · not saved, retry in settings</span>}
          </>
        }
      >
        {appSettings ? (
          <PaneList
            label={`${label} surfaces`}
            items={rows}
            getKey={row => row.surface}
            cursorKey={selected?.surface ?? null}
            onCursorChange={key => setCursor(key)}
            // Single-select: the highlight follows the cursor (the row the detail shows) and [x] tells the toggle.
            // Space toggles; a click only selects, so inspecting a row never flips its target.
            toggleHint="toggle target"
            onToggle={onToggle}
            renderItem={row => {
              const display = displayOf(row);
              return (
                <>
                  <span className="nm">
                    {row.targetId ? (row.targetEnabled ? "[x]" : "[ ]") : NO_TOGGLE} {row.name}{" "}
                    <span className="c-dim">{row.path}</span>
                  </span>
                  <span className={`meta ${toneClass(display.tone)}`.trim()}>{display.label}</span>
                </>
              );
            }}
          />
        ) : (
          <p className="c-dim">loading settings…</p>
        )}
      </Pane>

      <Pane
        id="detail"
        title={selected?.name ?? "detail"}
        label={`${label} detail`}
        scrollable
        meta={
          selectedDisplay && (
            <>
              {"· "}
              <RollingText key={selected?.surface} className={toneClass(selectedDisplay.tone)}>
                {selectedDisplay.label}
              </RollingText>
            </>
          )
        }
      >
        {!workspaceValid && (
          <p className="c-warn pane-note" role="status">
            The workspace folder is unusable. The workspace page says why.
          </p>
        )}
        {override && (
          <p className="rules-alert" role="alert">
            <Glyph name="conflict" tone="warn" /> <b>{override.title}.</b> {override.detail}
          </p>
        )}
        {facts.length > 0 && <Kv items={facts} />}
        {showRules && <RulesSummary model={rulesModel} error={rules.error} />}
        {activeModel && <FileConflictSummary model={activeModel} markedKey={markedKey} error={files.error} />}
        <div className="group">
          {"runtime · "}
          <span className={toneClass(verdict.tone) || undefined}>{verdict.text}</span>
        </div>
        {workspaceValid && <Kv items={runtimeRowsFor(runtime, skillLoadRows(skillLoads, harness))} />}
        {workspaceValid && runtimeExtra}
      </Pane>

      {outputStrip()}
    </section>
  );
}

/**
 * The facts of one surface row: where it lands, what feeds it, which toggle gates it, and its state. The backend's
 * detail line is left out where the rules summary below says the same thing in full.
 */
function surfaceFacts(row: HarnessRowModel, withDetail: boolean): KvItem[] {
  const also = row.alsoSurfaces.map(surfaceShortName).join(", ");
  const toggle = row.targetId
    ? `${row.target?.label ?? row.targetId} · ${row.targetEnabled ? "on" : "off"}${also ? ` · also ${also}` : ""}`
    : null;
  return [
    ...(row.path ? [{ label: "file", value: row.path }] : []),
    ...(row.path && row.target ? [{ label: "source", value: row.target.source_rel, tone: "dim" as const }] : []),
    ...(toggle ? [{ label: "target", value: toggle }] : []),
    ...(withDetail && row.detail ? [{ label: "detail", value: row.detail, wrap: true }] : []),
  ];
}
