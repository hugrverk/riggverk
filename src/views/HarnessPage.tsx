import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CodexConfigSummary } from "../components/CodexConfigSummary";
import { ConflictPane } from "../components/ConflictPane";
import { FileConflictSummary } from "../components/FileConflictSummary";
import { CellButton } from "../components/harness/CellButton";
import { RuntimeCell } from "../components/harness/RuntimeCell";
import { SurfaceCell } from "../components/harness/SurfaceCell";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { OutputStrip, useFocusOutputOnNewTransaction } from "../components/OutputStrip";
import { RulesPane } from "../components/RulesPane";
import { RulesSummary } from "../components/RulesSummary";
import { useFileConflictActions } from "../hooks/useFileConflictActions";
import { useCodexConfigActions } from "../hooks/useCodexConfigActions";
import { useFileConflictFlow } from "../hooks/useFileConflictFlow";
import { useRulesActions } from "../hooks/useRulesActions";
import { useRulesFlow } from "../hooks/useRulesFlow";
import { useKeymap } from "../keyboard/useKeymap";
import {
  fileConflictModelFor,
  fileGates,
  filesSurfacesOf,
  markedUnit,
  nextUnitKey,
  type FileConflictModel,
} from "../lib/fileConflicts";
import { CODEX_CONFIG_SURFACE, codexConfigGates, codexConfigModelFor } from "../lib/codexConfig";
import { harnessHomePath, harnessSubline } from "../lib/harnessHeader";
import { HARNESS_LABELS } from "../lib/harnessInstallation";
import { runtimeRowsFor, runtimeVerdict, type HarnessRuntimeHealth } from "../lib/harnessRuntimeRows";
import {
  harnessRowsFor,
  previewDisabledFor,
  surfaceShortName,
  updateActionFor,
  WORKSPACE_FOLDER_UNUSABLE,
  type HarnessRowModel,
} from "../lib/installationView";
import { ROW_LABEL, ROW_ORDER } from "../lib/overviewModel";
import { rulesGates, rulesModelFor, rulesOverrideWarning, rulesSurfaceOf } from "../lib/rulesView";
import { harnessUiItems } from "../lib/shellSummary";
import { skillLoadProblemCount, skillLoadRows, skillReadsRows, summarizeSkillLoads } from "../lib/skillLoadRows";
import type { UiItem, UiState } from "../lib/uiState";
import { Kv, type KvItem } from "../ui/Kv";
import { Page } from "../ui/Page";
import { TButton } from "../ui/TButton";
import type { InstallAgent } from "../types";
import { installBindings } from "./installBindings";
import type { HarnessViewProps } from "./pageTypes";
import { SecurityPostureRows } from "./SecurityPostureRows";

export interface HarnessPageProps extends HarnessViewProps {
  harness: InstallAgent;
  runtime: HarnessRuntimeHealth;
  /** Extra content after the runtime facts (OpenCode: the editable model override). */
  runtimeExtra?: ReactNode;
}

/** The decision first, then what has to be fixed by hand, then the rest in reading order. */
const STATE_RANK: Partial<Record<UiState, number>> = { decide: 0, fix: 1 };

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Empty slots that finish the last row of single cells in the three-column grid, so the hairlines still close it. */
function fillerCount(cells: number): number {
  return (3 - (cells % 3)) % 3;
}

/**
 * One harness (Claude, Codex, OpenCode, Cursor, Copilot, Pi, Kilo) as a page: the name with one mono line under it, then
 * a hairline grid with a cell per surface (state pill, the switch of the target that gates it, and for a rules file,
 * Codex keys or skill and agent files in conflict their detail and buttons), the runtime facts, the OpenCode model and
 * the safety notes. A cell with a decision in it spans the row and comes first. The update and preview open the install
 * review in place of the page; so do Compare, Merge in updates and Review files (a diff or the preview of a change),
 * and only `y` there applies it.
 *
 * Every action is a button and also a page key (u p r, and d v m b c on the active cell: the one focus or the last
 * click is in, by default the first decision). The keys work with focus anywhere in the page (`Page`).
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
  dataFolderOk,
  onClearOutput,
}: HarnessPageProps) {
  const label = HARNESS_LABELS[harness];
  useFocusOutputOnNewTransaction(rollbackTransactionId);
  const entry = overview.entries[harness];
  const [activeSurface, setActiveSurface] = useState<string | null>(null);
  const [markedKey, setMarkedKey] = useState<string | null>(null);
  const saving = settingsSaveStatus === "saving" || settingsSaveStatus === "pending";

  const update = updateActionFor(harness, entry, { dataFolderOk, busyLabel: wsRunning, settingsSaving: saving });
  const previewDisabled = previewDisabledFor(harness, { dataFolderOk, busyLabel: wsRunning });

  const rows = useMemo(
    () => (appSettings ? harnessRowsFor(harness, entry, appSettings, agentTargets) : []),
    [appSettings, harness, entry, agentTargets],
  );
  const uiItems: UiItem[] = useMemo(
    () => (appSettings ? harnessUiItems(harness, entry, appSettings, dataFolderOk) : []),
    [appSettings, harness, entry, dataFolderOk],
  );
  const stateOf = (row: HarnessRowModel): UiItem | null => uiItems.find(item => item.surface === row.surface) ?? null;

  const rulesSurface = rulesSurfaceOf(harness);
  const rulesModel = dataFolderOk ? rulesModelFor(harness, entry?.status) : null;
  const codexConfigModel = dataFolderOk && harness === "codex" ? codexConfigModelFor(entry?.status) : null;
  const fileModels = dataFolderOk
    ? filesSurfacesOf(harness).flatMap((surface): FileConflictModel[] => {
        const model = fileConflictModelFor(entry?.status, surface);
        return model ? [model] : [];
      })
    : [];

  // Cells in page order: the decisions, what has to be fixed by hand, then the rest in reading order.
  const ordered = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const rank = (row: HarnessRowModel) => STATE_RANK[uiItems.find(item => item.surface === row.surface)?.state ?? "ok"] ?? 2;
        const position = (row: HarnessRowModel) => ROW_ORDER.indexOf(surfaceShortName(row.surface));
        return rank(a) - rank(b) || position(a) - position(b);
      }),
    [rows, uiItems],
  );
  const hasActions = (row: HarnessRowModel) =>
    (row.surface === rulesSurface && rulesModel !== null) ||
    (row.surface === CODEX_CONFIG_SURFACE && codexConfigModel !== null) ||
    fileModels.some(model => model.surface === row.surface);
  // The keys act on the cell focus or a click was last in; until then on the first decision, else the first cell with actions.
  const selected =
    rows.find(row => row.surface === activeSurface) ??
    ordered.find(row => stateOf(row)?.state === "decide") ??
    ordered.find(hasActions) ??
    ordered[0] ??
    null;

  const rulesFlow = useRulesFlow({ runWorkspaceTask, refresh: refreshAfterApply, onApplied });
  const installOpen = install.isOpenOn(harness);
  const rules = useRulesActions({
    harness,
    model: rulesModel,
    dataFolderOk,
    busyLabel: wsRunning,
    installOpen,
    flow: rulesFlow,
    paneIds: ["page"],
    // d, v and m act on the rules file: offered only while its cell is the active one.
    active: rulesSurface !== null && selected?.surface === rulesSurface,
    reload: () => overview.refresh(),
  });
  // `:update` can open the install review while a rules review is showing; the install review wins.
  useEffect(() => {
    if (installOpen) rulesFlow.close();
  }, [installOpen, rulesFlow.close]);

  // Skill and agent files in conflict, or kept: c, d, b and m act on them while their cell is the active one.
  const conflictFlow = useFileConflictFlow({ runWorkspaceTask, refresh: refreshAfterApply, onApplied });
  const activeModel = fileModels.find(model => model.surface === selected?.surface) ?? null;
  const files = useFileConflictActions({
    harness,
    models: fileModels,
    activeSurface: activeModel?.surface ?? null,
    dataFolderOk,
    busyLabel: wsRunning,
    installOpen,
    rulesOpen: rulesFlow.open,
    flow: conflictFlow,
    paneIds: ["page"],
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

  // Codex config: `m` keeps the enforced keys that differ from Riggverk's, or hands the kept ones back.
  const codexConfig = useCodexConfigActions({
    model: codexConfigModel,
    dataFolderOk,
    busyLabel: wsRunning,
    blockedBy: installOpen
      ? "close the install review first"
      : rulesFlow.open
        ? "close the rules review first"
        : conflictFlow.state.status !== "idle"
          ? "close the conflict review first"
          : null,
    paneIds: ["page"],
    active: selected?.surface === CODEX_CONFIG_SURFACE,
    // The runtime health reads the choice too: its config row follows.
    reload: async () => {
      await Promise.all([overview.refresh(), refreshAfterApply()]);
    },
  });

  useKeymap(
    installBindings({
      idPrefix: harness,
      paneIds: ["page"],
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
      dataFolderOk={dataFolderOk}
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

  // With an unusable workspace folder there is no runtime to judge: the verdict says so and no rows follow.
  const verdict = dataFolderOk ? runtimeVerdict(runtime) : { text: WORKSPACE_FOLDER_UNUSABLE, tone: "dim" as const };
  const override = rulesOverrideWarning(runtime.harness === "codex" ? runtime.health : null);
  const conflictDetails = entry?.status?.conflict_details ?? [];

  // Names the harness loads from several folders: the skills cell says how many.
  const skillSummary = summarizeSkillLoads(skillLoads.loads, harness);
  const skillProblems = skillLoadProblemCount(skillSummary);
  const subline = harnessSubline({
    home: harnessHomePath(agentTargets, harness),
    skills: skillSummary?.names ?? null,
    runtime,
    dataFolderOk,
  });

  const ruleGates = rulesGates(rulesModel, { dataFolderOk, busyLabel: wsRunning, blockedBy: null });
  const codexGates = codexConfigGates(codexConfigModel, { dataFolderOk, busyLabel: wsRunning, blockedBy: null });

  const renderCell = (row: HarnessRowModel) => {
    const ui = stateOf(row);
    const state = ui?.state ?? null;
    const short = surfaceShortName(row.surface);
    const active = selected?.surface === row.surface;
    const isRules = row.surface === rulesSurface && rulesModel !== null;
    const isCodexConfig = row.surface === CODEX_CONFIG_SURFACE && codexConfigModel !== null;
    const fileModel = fileModels.find(model => model.surface === row.surface) ?? null;
    const explains = state === "decide" || state === "fix" || state === "ready" || state === "yours";
    const names = row.surface === "skills" ? skillSummary?.names : undefined;
    const headline = explains
      ? ui?.subline || row.detail || row.name
      : names !== undefined
        ? `${names} skill${names === 1 ? "" : "s"}`
        : row.path
          ? baseName(row.path)
          : (ROW_LABEL[short] ?? short);
    const notes = [
      ...(explains ? [] : ui?.subline ? [ui.subline] : []),
      ...(row.surface === "skills" && skillProblems > 0
        ? [`${skillProblems} skill name${skillProblems === 1 ? "" : "s"} with several copies`]
        : []),
    ];

    const unit = markedUnit(fileModel, markedKey);
    const fileGate = fileGates(fileModel, unit, { dataFolderOk, busyLabel: wsRunning, blockedBy: null });
    const actions = (
      <>
        {isRules && (
          <>
            <CellButton gate={ruleGates.diff} keyName="d" active={active} onClick={() => rules.run("diff")}>
              Compare
            </CellButton>
            <CellButton
              gate={ruleGates.convert}
              keyName="v"
              active={active}
              variant={rulesModel.kind === "conflict" ? "primary" : undefined}
              onClick={() => rules.run("convert")}
            >
              Merge in updates…
            </CellButton>
            <CellButton gate={ruleGates.leave} keyName="m" active={active} onClick={() => rules.run("leave")}>
              Keep mine
            </CellButton>
            <CellButton gate={ruleGates.manage} keyName="m" active={active} onClick={() => rules.run("manage")}>
              Hand back
            </CellButton>
          </>
        )}
        {isCodexConfig && (
          <>
            <CellButton gate={codexGates.keep} keyName="m" active={active} onClick={codexConfig.run}>
              Keep mine
            </CellButton>
            <CellButton gate={codexGates.handBack} keyName="m" active={active} onClick={codexConfig.run}>
              Hand back
            </CellButton>
          </>
        )}
        {fileModel && (
          <>
            <CellButton gate={fileGate.diff} keyName="d" active={active} onClick={() => files.runOn("diff", fileModel.surface)}>
              Review files
            </CellButton>
            <CellButton gate={fileGate.bundled} keyName="b" active={active} onClick={() => files.runOn("bundled", fileModel.surface)}>
              Use Riggverk&rsquo;s version…
            </CellButton>
            <CellButton gate={fileGate.keep} keyName="m" active={active} onClick={() => files.runOn("mine", fileModel.surface)}>
              Keep mine
            </CellButton>
            <CellButton gate={fileGate.manage} keyName="m" active={active} onClick={() => files.runOn("manage", fileModel.surface)}>
              Hand back
            </CellButton>
            <CellButton
              gate={fileGate.next}
              keyName="c"
              active={active}
              onClick={() => {
                const next = nextUnitKey(fileModel, markedKey);
                if (next) setMarkedKey(next);
              }}
            >
              Next file
            </CellButton>
          </>
        )}
      </>
    );

    return (
      <SurfaceCell
        key={row.surface}
        surface={row.surface}
        label={`${ROW_LABEL[short] ?? short}${row.path ? ` · ${row.path}` : ""}`}
        headline={headline}
        state={state}
        note={notes.length > 0 ? notes.join(" · ") : null}
        wide={state === "decide" || state === "fix"}
        active={active}
        onActivate={() => setActiveSurface(row.surface)}
        toggle={
          row.targetId
            ? {
                checked: row.targetEnabled === true,
                label: `Let Riggverk manage ${row.target?.label ?? row.name}`,
                onChange: () => onToggleTarget(row.targetId!),
                note: row.alsoSurfaces.length > 0 ? `Also ${row.alsoSurfaces.map(surfaceShortName).join(", ")}` : null,
              }
            : null
        }
        actions={actions}
      >
        {isRules && <RulesSummary model={rulesModel} error={rules.error} />}
        {isCodexConfig && <CodexConfigSummary model={codexConfigModel} error={codexConfig.error} />}
        {fileModel && <FileConflictSummary model={fileModel} markedKey={markedKey} error={files.error} />}
        {row.surface === "skills" && <SkillReads reads={skillReadsRows(skillLoads, harness)} />}
      </SurfaceCell>
    );
  };

  const wideCells = ordered.filter(row => ["decide", "fix"].includes(stateOf(row)?.state ?? ""));
  const singleCells = ordered.filter(row => !wideCells.includes(row));

  return (
    <div className="hp">
      <Page label={label} className="hp-page">
        <header className="hp-head">
          <div>
            <h4 className="hp-title">{label}</h4>
            <p className="hp-sub">
              {subline}
              {saving && <span role="status"> · autosaving…</span>}
              {settingsSaveStatus === "error" && <span role="status"> · not saved, retry in settings</span>}
            </p>
          </div>
          <div className="hp-head-actions">
            <TButton
              keys={["p"]}
              shortcut="p"
              disabled={previewDisabled}
              onClick={() => void install.open(harness, { readOnly: true })}
            >
              Preview
            </TButton>
            <TButton
              keys={["u"]}
              shortcut="u"
              variant="primary"
              disabled={update.disabled}
              onClick={() => void install.open(harness)}
            >
              {update.label}
            </TButton>
          </div>
        </header>

        {!dataFolderOk && (
          <p className="hp-alert" role="status">
            The workspace folder is unusable. The Overview page says why.
          </p>
        )}
        {override && (
          <p className="hp-alert" role="alert">
            <b>{override.title}.</b> {override.detail}
          </p>
        )}
        {entry?.error && (
          <p className="hp-alert" role="status">
            Status check failed: {entry.error}
          </p>
        )}
        {conflictDetails.length > 0 && fileModels.length === 0 && (
          <p className="hp-alert" role="status">
            The update left alone: {conflictDetails.join(", ")}
          </p>
        )}

        {appSettings ? (
          <div className="hp-grid">
            {wideCells.map(renderCell)}
            {singleCells.map(renderCell)}
            {Array.from({ length: fillerCount(singleCells.length) }, (_, index) => (
              <div key={`fill-${index}`} className="hp-cell hp-fill" aria-hidden="true" />
            ))}
            <RuntimeCell
              verdict={verdict}
              rows={dataFolderOk ? runtimeRowsFor(runtime, skillLoadRows(skillLoads, harness)) : []}
            />
            {dataFolderOk && runtimeExtra && (
              <div className="hp-cell hp-span3 hp-model">
                <span className="hp-lbl">Model</span>
                {runtimeExtra}
              </div>
            )}
            <SecurityPostureRows harness={harness} refreshKey={`${wsRunning === null}:${entry?.status?.state ?? ""}`} />
          </div>
        ) : (
          <p className="hp-loading">Loading settings…</p>
        )}
      </Page>
      <div className="hp-strip">{outputStrip()}</div>
    </div>
  );
}

/** The folders the harness reads its skills from, under the skills cell. */
function SkillReads({ reads }: { reads: readonly KvItem[] }) {
  return reads.length > 0 ? <Kv items={reads} className="hp-kv" aria-label="Skill folders" /> : null;
}
