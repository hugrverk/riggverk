import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { codexConfigGates, keepMessage, keyNames, type CodexConfigModel } from "../lib/codexConfig";
import { useShellState } from "../shell/ShellState";

export interface UseCodexConfigActionsOptions {
  /** The Codex config's kept and keepable keys, or null (no such keys, the target is off, status not loaded). */
  model: CodexConfigModel | null;
  dataFolderOk: boolean;
  busyLabel: string | null;
  /** A review (install, rules or conflict) is open on this page. */
  blockedBy: string | null;
  /** Panes whose focus offers `m` as a status-bar hint. */
  paneIds: readonly string[];
  /** Whether the key applies right now (the page's cursor is on the Codex config row). Default true. */
  active?: boolean;
  /** Reload installation state and runtime health after keeping or handing back changed. */
  reload: () => void | Promise<void>;
}

export interface CodexConfigActions {
  /** Why the last keep or hand back failed, or null. */
  error: string | null;
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
  paneIds,
  active = true,
  reload,
}: UseCodexConfigActionsOptions): CodexConfigActions {
  const confirm = useConfirm();
  const { beginConfirm, notify } = useShellState();
  const [error, setError] = useState<string | null>(null);
  const gates = codexConfigGates(model, { dataFolderOk, busyLabel, blockedBy });

  const setKept = useCallback(
    async (kept: boolean) => {
      if (!model) return;
      if (kept) {
        const release = beginConfirm();
        let approved = false;
        try {
          approved = await confirm({ title: "Keep mine", message: keepMessage(model.differing), confirmLabel: "keep mine" });
        } finally {
          release();
        }
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
    [model, confirm, beginConfirm, notify, reload],
  );

  // `m` is one key with two meanings: keep what differs, or hand back what is kept.
  const gate = gates.keep.visible ? gates.keep : gates.handBack;
  const bindings: Binding[] = paneIds.map(
    (paneId): Binding => ({
      id: `codex.${paneId}.config-keep`,
      keys: "m",
      title: gates.keep.visible ? "Keep my values for the Codex config keys that differ" : "Hand the kept Codex config keys back to Riggverk",
      hint: gates.keep.visible ? "keep mine" : "hand back",
      group: "Codex config",
      scope: "pane",
      paneId,
      when: () => (!active || !gate.visible ? false : (gate.reason ?? true)),
      run: () => {
        if (!active || !gate.visible || gate.reason !== null) return;
        void setKept(gates.keep.visible);
      },
    }),
  );
  useKeymap(bindings, { enabled: blockedBy === null });

  return { error };
}
