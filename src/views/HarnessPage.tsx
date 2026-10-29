import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CodexDefaultsPane } from "../components/CodexDefaultsPane";
import { ConflictPane } from "../components/ConflictPane";
import { CodexConfigDecision } from "../components/decisions/CodexConfigDecision";
import { FilesDecision } from "../components/decisions/FilesDecision";
import { RulesDecision } from "../components/decisions/RulesDecision";
import { RuntimeCell } from "../components/harness/RuntimeCell";
import { SurfaceCell } from "../components/harness/SurfaceCell";
import { InstallPlanPane } from "../components/InstallPlanPane";
import { RulesPane } from "../components/RulesPane";
import { useCodexDefaultsFlow } from "../hooks/useCodexDefaultsFlow";
import { useFileConflictActions } from "../hooks/useFileConflictActions";
import { useCodexConfigActions } from "../hooks/useCodexConfigActions";
import { useFileConflictFlow } from "../hooks/useFileConflictFlow";
import { useRulesActions } from "../hooks/useRulesActions";
import { useRulesFlow } from "../hooks/useRulesFlow";
import { useKeymap } from "../keyboard/useKeymap";
import { fileConflictModelFor, filesSurfacesOf, type FileConflictModel } from "../lib/fileConflicts";
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
import { rulesFileName, rulesGates, rulesModelFor, rulesOverrideWarning, rulesSurfaceOf } from "../lib/rulesView";
import { harnessUiItems } from "../lib/shellSummary";
import { skillLoadProblemCount, skillLoadRows, skillReadsRows, summarizeSkillLoads } from "../lib/skillLoadRows";
import { READY_TO_INSTALL_LABEL, type UiItem, type UiState } from "../lib/uiState";
import { tailStyle } from "../ui/gridTail";
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

/**
 * One harness (Claude, Codex, OpenCode, Cursor, Copilot, Pi, Kilo) as a page: the name with one mono line under it, then
 * a hairline grid with a cell per surface (state pill, the switch of the target that gates it, and for a rules file,
 * Codex keys or skill and agent files in conflict their decision: the why line, the buttons, the choices), the runtime
 * facts, the OpenCode model and the safety notes. A cell with a decision in it spans the row and comes first. Compare
 * folds out inline under its cell (a read-only side-by-side diff; the page stays and its keys keep working). The update
 * and preview open the install review in place of the page; so do Merge in updates, Use Riggverk's version and Use
 * Riggverk defaults (the preview of a change), and only `y` there applies it.
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
  runWorkspaceTask,
  refreshAfterApply,
  onApplied,
  wsRunning,
  dataFolderOk,
}: HarnessPageProps) {
  const label = HARNESS_LABELS[harness];
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
    rulesOpen: rulesFlow.reviewing,
    flow: conflictFlow,
    paneIds: ["page"],
    markedKey,
    onMark: setMarkedKey,
    // The kept flag of a skill copy shows in the skill loads too.
    reload: async () => {
      await Promise.all([overview.refresh(), skillLoads.refresh()]);
    },
  });
  // Another review opening closes the conflict review (and its inline diff); the install and rules reviews win.
  useEffect(() => {
    if (installOpen || rulesFlow.reviewing) conflictFlow.close();
  }, [installOpen, rulesFlow.reviewing, conflictFlow.close]);

  // Codex config: `m` keeps the enforced keys that differ from Riggverk's, or hands the kept ones back; `b` previews
  // setting them to Riggverk's values (the review, then `y`).
  const defaultsFlow = useCodexDefaultsFlow({ runWorkspaceTask, refresh: refreshAfterApply, onApplied });
  useEffect(() => {
    if (installOpen || rulesFlow.reviewing || conflictFlow.reviewing) defaultsFlow.close();
  }, [installOpen, rulesFlow.reviewing, conflictFlow.reviewing, defaultsFlow.close]);
  const codexConfig = useCodexConfigActions({
    model: codexConfigModel,
    dataFolderOk,
    busyLabel: wsRunning,
    blockedBy: installOpen
      ? "close the install review first"
      : rulesFlow.reviewing
        ? "close the rules review first"
        : conflictFlow.reviewing
          ? "close the conflict review first"
          : defaultsFlow.open
            ? "close the config review first"
            : null,
    defaults: defaultsFlow,
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
    { enabled: !installOpen && !rulesFlow.reviewing && !conflictFlow.reviewing && !defaultsFlow.open },
  );

  if (installOpen) {
    return (
      <section className="screen review" aria-label={`${label} install review`}>
        <InstallPlanPane flow={install.flow} busyLabel={wsRunning} backupRoot={backupRoot} onApply={install.apply} />
      </section>
    );
  }

  if (rulesFlow.reviewing) {
    return (
      <section className="screen review" aria-label={`${label} rules review`}>
        <RulesPane
          flow={rulesFlow}
          busyLabel={wsRunning}
          backupRoot={backupRoot}
        />
      </section>
    );
  }

  const conflictReview = conflictFlow.state;
  if (conflictFlow.reviewing && conflictReview.status !== "idle") {
    const reviewed = fileModels.find(model => model.surface === conflictReview.surface);
    return (
      <section className="screen review" aria-label={`${label} conflict review`}>
        <ConflictPane
          flow={conflictFlow}
          units={reviewed?.units ?? []}
          busyLabel={wsRunning}
          backupRoot={backupRoot}
        />
      </section>
    );
  }

  if (defaultsFlow.open) {
    return (
      <section className="screen review" aria-label={`${label} config review`}>
        <CodexDefaultsPane flow={defaultsFlow} busyLabel={wsRunning} backupRoot={backupRoot} />
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

  const isWide = (row: HarnessRowModel) => {
    const state = stateOf(row)?.state ?? null;
    if (state === "decide" || state === "fix") return true;
    const hasDecision =
      (row.surface === rulesSurface && rulesModel !== null) ||
      (row.surface === CODEX_CONFIG_SURFACE && codexConfigModel !== null) ||
      fileModels.some(model => model.surface === row.surface);
    return hasDecision && (state === "ready" || state === "yours");
  };

  const renderCell = (row: HarnessRowModel, tail: boolean) => {
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

    const reads = row.surface === "skills" ? <SkillReads reads={skillReadsRows(skillLoads, harness)} /> : null;
    // A decision (or anything with a Compare fold-out) takes the row, so the diff has room.
    const wide = isWide(row);
    const gateContext = { dataFolderOk, busyLabel: wsRunning, blockedBy: null };

    return (
      <SurfaceCell
        key={row.surface}
        surface={row.surface}
        label={`${ROW_LABEL[short] ?? short}${row.path ? ` · ${row.path}` : ""}`}
        headline={headline}
        state={state}
        stateLabel={state === "ready" && (row.state === "not_installed" || (isRules && rulesModel.kind === "absent")) ? READY_TO_INSTALL_LABEL : undefined}
        note={notes.length > 0 ? notes.join(" · ") : null}
        wide={wide}
        tail={tail && !wide}
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
      >
        {isRules && (
          <RulesDecision
            model={rulesModel}
            harnessLabel={label}
            fileName={rulesFileName(harness)}
            flow={rulesFlow}
            rules={rules}
            gates={ruleGates}
            active={active}
          />
        )}
        {isCodexConfig && <CodexConfigDecision model={codexConfigModel} gates={codexGates} codexConfig={codexConfig} active={active} />}
        {fileModel && (
          <FilesDecision
            model={fileModel}
            flow={conflictFlow}
            files={files}
            markedKey={markedKey}
            onMark={setMarkedKey}
            context={gateContext}
            active={active}
            aside={reads}
          />
        )}
        {!fileModel && reads}
      </SurfaceCell>
    );
  };

  const wideCells = ordered.filter(isWide);
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
          <div className="hp-grid" style={tailStyle(singleCells.length)}>
            {wideCells.map(row => renderCell(row, false))}
            {singleCells.map((row, index) => renderCell(row, index === singleCells.length - 1))}
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
    </div>
  );
}

/** The folders the harness reads its skills from, under the skills cell. */
function SkillReads({ reads }: { reads: readonly KvItem[] }) {
  return reads.length > 0 ? <Kv items={reads} className="hp-kv" aria-label="Skill folders" /> : null;
}
