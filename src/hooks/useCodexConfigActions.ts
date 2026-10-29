import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { codexConfigGates, keepMessage, keyNames, type CodexConfigModel } from "../lib/codexConfig";
import { useShellState } from "../shell/ShellState";
import type { CodexDefaultsFlow } from "./useCodexDefaultsFlow";

export interface UseCodexConfigActionsOptions {
  /** The Codex config's kept and keepable keys, or null (no such keys, the target is off, status not loaded). */
  model: CodexConfigModel | null;
  dataFolderOk: boolean;
  busyLabel: string | null;
  /** A review (install, rules or conflict) is open on this page. */
  blockedBy: string | null;
  /** The "use Riggverk defaults" review: `b` opens its preview. */
  defaults: CodexDefaultsFlow;
  /** Panes whose focus offers `m` and `b` as key hints. */
  paneIds: readonly string[];
  /** Whether the key applies right now (the page's cursor is on the Codex config row). Default true. */
  active?: boolean;
  /** Reload installation state and runtime health after keeping or handing back changed. */
  reload: () => void | Promise<void>;
}

export interface CodexConfigActions {
  /** Why the last keep or hand back failed, or null. */
  error: string | null;
  /** What `m` does (keep what differs, or hand the kept keys back), for a button; the same gates apply. */
  run: () => void;
  /** Preview setting the differing keys to Riggverk's values (`b`), for a button; the same gates apply. Writes nothing. */
  runDefaults: () => void;
}

/**
 * `m` on the Codex config row: keep my value for the enforced keys that differ from Riggverk's, or, once they are
 * kept, hand them back. Both write the choice only (`config-preferences.json`), never `config.toml`; keeping asks
 * first, handing back does not.
 */
export function useCodexConfigActions({
  model,
  dataFolderOk,
  busyLabel,
  blockedBy,
  defaults,
  paneIds,
  active = true,
  reload,
}: UseCodexConfigActionsOptions): CodexConfigActions {
  const confirm = useConfirm();
  const { notify } = useShellState();
  const [error, setError] = useState<string | null>(null);
  const gates = codexConfigGates(model, { dataFolderOk, busyLabel, blockedBy });

  const setKept = useCallback(
    async (kept: boolean) => {
      if (!model) return;
      if (kept) {
        const approved = await confirm({
          title: "Keep mine",
          message: keepMessage(model.differing),
          confirmLabel: "keep mine",
        });
        if (!approved) return;
      }
      try {
        await invoke("set_codex_config_kept", { kept });
        setError(null);
        notify(
          kept
            ? `Codex config: you keep ${keyNames(model.differing)}`
            : `Codex config: Riggverk manages ${keyNames(model.kept)} again`,
          { tone: "ok" },
        );
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [model, confirm, notify, reload],
  );

  // `m` is one key with two meanings: keep what differs, or hand back what is kept.
  const gate = gates.keep.visible ? gates.keep : gates.handBack;
  const run = () => {
    if (!gate.visible || gate.reason !== null) return;
    void setKept(gates.keep.visible);
  };
  const runDefaults = () => {
    if (!gates.defaults.visible || gates.defaults.reason !== null) return;
    void defaults.openPreview();
  };
  const bindings: Binding[] = paneIds.flatMap((paneId): Binding[] => [
    {
      id: `codex.${paneId}.config-keep`,
      keys: "m",
      title: gates.keep.visible ? "Keep my values for the Codex config keys that differ" : "Hand the kept Codex config keys back to Riggverk",
      hint: gates.keep.visible ? "keep mine" : "hand back",
      group: "Codex config",
      scope: "pane",
      paneId,
      when: () => (!active || !gate.visible ? false : (gate.reason ?? true)),
      run: () => {
        if (!active) return;
        run();
      },
    },
    {
      id: `codex.${paneId}.config-defaults`,
      keys: "b",
      title: "Preview setting the Codex config keys that differ to Riggverk's values",
      hint: "use Riggverk defaults",
      group: "Codex config",
      scope: "pane",
      paneId,
      when: () => (!active || !gates.defaults.visible ? false : (gates.defaults.reason ?? true)),
      run: () => {
        if (!active) return;
        runDefaults();
      },
    },
  ]);
  useKeymap(bindings, { enabled: blockedBy === null });

  return { error, run, runDefaults };
}
