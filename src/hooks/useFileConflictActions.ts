import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import type { CommandSpec, ParsedCommand } from "../keyboard/commands/parser";
import { useCommands } from "../keyboard/commands/useCommands";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import {
  fileGates,
  markedUnit,
  nextUnitKey,
  type FileConflictModel,
  type FileGate,
  type FileGates,
} from "../lib/fileConflicts";
import { useShellState } from "../shell/ShellState";
import type { FilesSurfaceId, FileUnit } from "../types";
import type { FileConflictFlow } from "./useFileConflictFlow";

export type FileAction = "diff" | "mine" | "manage";

const ACTIONS: readonly FileAction[] = ["diff", "mine", "manage"];

const ACTION_SUMMARY: Record<FileAction, string> = {
  diff: "show your file against the bundled one",
  mine: "keep your version; updates never write it and bundled updates stay visible",
  manage: "hand a kept file back to the app",
};

export interface UseFileConflictActionsOptions {
  harness: string;
  /** The files surfaces of this page that have conflicting or kept files. */
  models: readonly FileConflictModel[];
  /** The files surface the page's cursor is on, or null. The keys are offered only while it is set. */
  activeSurface: FilesSurfaceId | null;
  workspaceValid: boolean;
  busyLabel: string | null;
  /** An install review is open on this page. */
  installOpen: boolean;
  /** A rules review is open on this page. */
  rulesOpen: boolean;
  flow: FileConflictFlow;
  /** Panes whose focus offers `c`, `d` and `m` as status-bar hints. */
  paneIds: readonly string[];
  /** The unit the keys act on (a key from the model), or null for the first. */
  markedKey: string | null;
  onMark: (key: string) => void;
  /** Reload what keeping or handing back changed (installation state, skill loads). */
  reload: () => void | Promise<void>;
}

export interface FileConflictActions {
  /** Why the last keep or hand back failed, or null. */
  error: string | null;
  /** `m` on a unit: keep my version when it is in conflict, hand it back when it is kept. */
  toggleKept: (surface: FilesSurfaceId, unit: FileUnit) => void;
}

interface Target {
  model: FileConflictModel;
  unit: FileUnit;
}

/** The text of the confirm that keeping asks first. */
function keepMessage(unit: FileUnit): string {
  const files = unit.files.filter(file => file.state === "conflict").length + unit.more_files;
  if (unit.kind === "agent") {
    return `Keep your version of ${unit.name} in ${unit.folder}? Riggverk stops proposing changes to it and never writes it. Bundled updates stay visible; press m again to hand it back.`;
  }
  return `Keep your version of ${unit.name} in ${unit.folder} (${files} file${files === 1 ? "" : "s"})? Riggverk stops proposing changes to ${files === 1 ? "it" : "them"} and never writes ${files === 1 ? "it" : "them"}. Other files of the skill keep updating. Bundled updates stay visible; press m again to hand ${files === 1 ? "it" : "them"} back.`;
}

/**
 * `c` next conflict, `d` diff and `m` keep mine / hand back on a harness page, and the `:resolve` command. All of
 * them read the same gates, so a key and its command are available in exactly the same situations. Keeping and
 * handing back write the choice only (`kept-files.json`), never a skill or agent file; keeping asks first, handing
 * back does not, and the diff goes through the review pane.
 */
export function useFileConflictActions({
  harness,
  models,
  activeSurface,
  workspaceValid,
  busyLabel,
  installOpen,
  rulesOpen,
  flow,
  paneIds,
  markedKey,
  onMark,
  reload,
}: UseFileConflictActionsOptions): FileConflictActions {
  const confirm = useConfirm();
  const { beginConfirm, notify } = useShellState();
  const [error, setError] = useState<string | null>(null);

  const blockedBy = installOpen
    ? "close the install review first"
    : rulesOpen
      ? "close the rules review first"
      : flow.open
        ? "close the conflict review first"
        : null;
  const context = { workspaceValid, busyLabel, blockedBy };
  const activeModel = models.find(model => model.surface === activeSurface) ?? null;
  const activeUnit = markedUnit(activeModel, markedKey);
  const gates = fileGates(activeModel, activeUnit, context);

  const setKept = useCallback(
    async (surface: FilesSurfaceId, unit: FileUnit, kept: boolean) => {
      if (kept) {
        const release = beginConfirm();
        let approved = false;
        try {
          approved = await confirm({ title: "Keep mine", message: keepMessage(unit), confirmLabel: "keep mine" });
        } finally {
          release();
        }
        if (!approved) return;
      }
      try {
        await invoke("set_files_kept", { surface, units: [unit.key], kept });
        setError(null);
        notify(kept ? `${unit.name}: kept, you manage it` : `${unit.name}: Riggverk manages it again`, { tone: "ok" });
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [confirm, beginConfirm, notify, reload],
  );

  const toggleKept = useCallback(
    (surface: FilesSurfaceId, unit: FileUnit) => void setKept(surface, unit, unit.state === "conflict"),
    [setKept],
  );

  const execute = (action: FileAction, target: Target) => {
    const { model, unit } = target;
    onMark(unit.key);
    if (action === "diff") void flow.openDiff(model.surface, unit.key);
    else void setKept(model.surface, unit, action === "mine");
  };

  const gateFor = (action: FileAction, found: FileGates): FileGate =>
    action === "diff" ? found.diff : action === "mine" ? found.keep : found.manage;

  // ── Keys ──
  const run = (action: FileAction) => {
    if (!activeModel || !activeUnit) return;
    const gate = gateFor(action, gates);
    if (!gate.visible || gate.reason !== null) return;
    execute(action, { model: activeModel, unit: activeUnit });
  };

  const whenFor = (gate: FileGate) => () => (!gate.visible ? false : gate.reason ?? true);
  const toggle = gates.manage.visible ? gates.manage : gates.keep;
  const bindings: Binding[] = paneIds.flatMap((paneId): Binding[] => [
    {
      id: `${harness}.${paneId}.files-diff`,
      keys: "d",
      title: "Show the marked skill or agent against the bundled one",
      hint: "diff",
      group: "Conflicts",
      scope: "pane",
      paneId,
      when: whenFor(gates.diff),
      run: () => run("diff"),
    },
    {
      id: `${harness}.${paneId}.files-keep`,
      keys: "m",
      title: gates.manage.visible ? "Hand the marked skill or agent back to the app" : "Keep my version of the marked skill or agent",
      hint: gates.manage.visible ? "hand back" : "keep mine",
      group: "Conflicts",
      scope: "pane",
      paneId,
      when: whenFor(toggle),
      run: () => run(gates.manage.visible ? "manage" : "mine"),
    },
    {
      id: `${harness}.${paneId}.files-next`,
      keys: "c",
      title: "Mark the next conflicting or kept skill or agent",
      hint: "next conflict",
      group: "Conflicts",
      scope: "pane",
      paneId,
      when: whenFor(gates.next),
      run: () => {
        if (!activeModel || gates.next.reason !== null) return;
        const next = nextUnitKey(activeModel, markedKey);
        if (next) onMark(next);
      },
    },
  ]);
  useKeymap(bindings, { enabled: !installOpen && !rulesOpen && !flow.open });

  // ── :resolve ──
  const unitNames = models.flatMap(model => model.units.map(unit => unit.name));

  /** The unit a `:resolve` line names (or the marked one), or why there is none. */
  const targetOf = (name: string | undefined): Target | string => {
    if (models.length === 0) return "there are no conflicting or kept skill or agent files on this page";
    if (!name) {
      if (activeModel && activeUnit) return { model: activeModel, unit: activeUnit };
      return "move the cursor to the skills or agents row, or name a skill or agent";
    }
    const named = (scope: readonly FileConflictModel[]) =>
      scope.flatMap(model => model.units.filter(unit => unit.name === name).map((unit): Target => ({ model, unit })));
    const here = activeModel ? named([activeModel]) : [];
    const found = here.length > 0 ? here : named(models);
    if (found.length === 0) return `no skill or agent named ${name} is in conflict or kept here`;
    if (found.length > 1) return `${name} has copies in several folders; mark one with c on the skills row`;
    return found[0]!;
  };

  const unavailable = (action: FileAction, unit: FileUnit): string =>
    action === "mine"
      ? `${unit.name} is already kept (:resolve manage hands it back)`
      : `${unit.name} is not kept (:resolve mine keeps it)`;

  const resolveCommand: CommandSpec = {
    name: "resolve",
    summary: "diff, keep or hand back a conflicting skill or agent file",
    group: "Conflicts",
    args: [
      { name: "action", kind: "enum", values: ACTIONS, describe: value => ACTION_SUMMARY[value as FileAction] },
      { name: "name", kind: "rest", optional: true, description: "skill or agent name; default the marked one" },
    ],
    complete: ({ args }) => (args.length === 1 ? [...new Set(unitNames)].map(value => ({ value })) : []),
    validate: (parsed: ParsedCommand) => {
      const action = parsed.named.action as FileAction | undefined;
      if (!action) return `resolve: name an action (${ACTIONS.join(" | ")})`;
      const target = targetOf(parsed.named.name);
      if (typeof target === "string") return `resolve ${action}: ${target}`;
      const gate = gateFor(action, fileGates(target.model, target.unit, context));
      if (!gate.visible) return `resolve ${action}: ${unavailable(action, target.unit)}`;
      return gate.reason ? `resolve ${action}: ${gate.reason}` : null;
    },
    run: (parsed: ParsedCommand) => {
      const target = targetOf(parsed.named.name);
      if (typeof target !== "string") execute(parsed.named.action as FileAction, target);
    },
  };
  useCommands([resolveCommand]);

  return { error, toggleKept };
}
