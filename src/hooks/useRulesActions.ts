import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import type { CommandSpec, ParsedCommand } from "../keyboard/commands/parser";
import { useCommands } from "../keyboard/commands/useCommands";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { HARNESS_LABELS } from "../lib/harnessInstallation";
import { RULES_HARNESSES, rulesFileName, rulesGates, type RulesGate, type RulesModel } from "../lib/rulesView";
import { useShellState } from "../shell/ShellState";
import type { InstallAgent } from "../types";
import type { RulesFlow } from "./useRulesFlow";

export type RulesAction = "diff" | "convert" | "leave" | "manage";

const ACTIONS: readonly RulesAction[] = ["diff", "convert", "leave", "manage"];

const ACTION_SUMMARY: Record<RulesAction, string> = {
  diff: "show what differs: your edits against the shipped base, or the update",
  convert: "preview converting the file onto the base block, then y applies (your edits are kept)",
  leave: "leave the hand-edited file as is; base updates stay available and you manage it",
  manage: "hand a left-as-is file back to the app",
};

export interface UseRulesActionsOptions {
  harness: InstallAgent;
  /** The rules file's model, or null (no rules surface, its target is off, status not loaded). */
  model: RulesModel | null;
  workspaceValid: boolean;
  busyLabel: string | null;
  /** An install review is open on this page. */
  installOpen: boolean;
  flow: RulesFlow;
  /** Panes whose focus offers `d`, `v` and `m` as status-bar hints. */
  paneIds: readonly string[];
  /**
   * Whether the keys apply right now (the page's cursor is on the rules file). When false they are not offered
   * and do nothing; `:rules` is not affected. Default true.
   */
  active?: boolean;
  /** Reload installation state after "leave as is" changed. */
  reload: () => void | Promise<void>;
}

export interface RulesActions {
  /** Why the last "leave as is" change failed, or null. */
  error: string | null;
  run: (action: RulesAction) => void;
}

function unavailable(action: RulesAction, model: RulesModel | null, label: string): string {
  if (!model) return `${label} has no managed rules file here (its rules target is off, or it is not loaded)`;
  switch (action) {
    case "diff":
      return model.diffDisabled || "no rules file is installed";
    case "convert":
      if (model.kind === "malformed") return "the markers are malformed; fix them by hand first";
      if (model.kind === "blocked") return "another file in the folder keeps the harness from reading this one; sort that out first";
      return "the file is not a conflict; there is nothing to convert";
    case "leave":
      return model.user_managed ? "already left as is (:rules manage hands it back)" : "the file is not a conflict; there is nothing to leave as is";
    case "manage":
      return "the file is not left as is";
  }
}

/**
 * `d` diff, `v` convert and `m` leave-as-is on a harness page, and the `:rules` command. All of them read the same
 * gates, so a key and its command are available in exactly the same situations. Only `leave` writes (the preference
 * file), and it asks first; conversion goes through the review pane and its `y`.
 */
export function useRulesActions({
  harness,
  model,
  workspaceValid,
  busyLabel,
  installOpen,
  flow,
  paneIds,
  active = true,
  reload,
}: UseRulesActionsOptions): RulesActions {
  const confirm = useConfirm();
  const { beginConfirm, notify } = useShellState();
  const [error, setError] = useState<string | null>(null);
  const label = HARNESS_LABELS[harness];

  const blockedBy = installOpen ? "close the install review first" : flow.open ? "close the rules review first" : null;
  const gates = rulesGates(model, { workspaceValid, busyLabel, blockedBy });

  const setManaged = useCallback(
    async (userManaged: boolean) => {
      if (!model) return;
      if (userManaged) {
        const release = beginConfirm();
        let approved = false;
        try {
          approved = await confirm({
            title: "Leave as is",
            message: `Leave ${rulesFileName(harness)} as it is? Riggverk stops proposing changes to it and never writes it. Base updates stay available; press m again to hand the file back, or convert it to keep your edits under the base block.`,
            confirmLabel: "leave as is",
          });
        } finally {
          release();
        }
        if (!approved) return;
      }
      try {
        await invoke("set_rules_user_managed", { surface: model.surface, userManaged });
        setError(null);
        notify(
          userManaged ? `${label} rules: left as is, you manage the file` : `${label} rules: the app manages the file again`,
          { tone: "ok" },
        );
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [model, harness, label, confirm, beginConfirm, notify, reload],
  );

  const gateOf = (action: RulesAction): RulesGate => gates[action];

  const run = (action: RulesAction) => {
    if (!model || gateOf(action).reason !== null || !gateOf(action).visible) return;
    switch (action) {
      case "diff":
        void flow.openDiff(model.surface, model.diffMode);
        break;
      case "convert":
        void flow.openConversion(model.surface);
        break;
      case "leave":
        void setManaged(true);
        break;
      case "manage":
        void setManaged(false);
        break;
    }
  };

  const whenFor = (gate: RulesGate) => () => (!active || !gate.visible ? false : gate.reason ?? true);
  // `m` is one key with two meanings: leave a conflict as is, or hand a left-as-is file back.
  const toggle = gates.manage.visible ? gates.manage : gates.leave;
  const bindings: Binding[] = paneIds.flatMap((paneId): Binding[] => [
    {
      id: `${harness}.${paneId}.rules-diff`,
      keys: "d",
      title: "Show the rules diff",
      hint: "diff",
      group: "Rules",
      scope: "pane",
      paneId,
      when: whenFor(gates.diff),
      run: () => run("diff"),
    },
    {
      id: `${harness}.${paneId}.rules-convert`,
      keys: "v",
      title: "Preview converting the rules file onto the base block",
      hint: "convert",
      group: "Rules",
      scope: "pane",
      paneId,
      when: whenFor(gates.convert),
      run: () => run("convert"),
    },
    {
      id: `${harness}.${paneId}.rules-manage`,
      keys: "m",
      title: gates.manage.visible ? "Hand the rules file back to the app" : "Leave the rules file as is",
      hint: gates.manage.visible ? "hand back" : "leave as is",
      group: "Rules",
      scope: "pane",
      paneId,
      when: whenFor(toggle),
      run: () => run(gates.manage.visible ? "manage" : "leave"),
    },
  ]);
  useKeymap(bindings, { enabled: !installOpen && !flow.open });

  const reasonFor = (action: RulesAction): true | string => {
    const gate = gateOf(action);
    if (!gate.visible) return unavailable(action, model, label);
    return gate.reason ?? true;
  };

  const rulesCommand: CommandSpec = {
    name: "rules",
    summary: "diff, convert or leave as is a hand-edited rules file",
    group: "Rules",
    args: [
      { name: "action", kind: "enum", values: ACTIONS, describe: value => ACTION_SUMMARY[value as RulesAction] },
      {
        name: "harness",
        kind: "enum",
        values: RULES_HARNESSES,
        optional: true,
        describe: value => (value === harness ? "this page" : `open the ${HARNESS_LABELS[value as InstallAgent]} page first`),
      },
    ],
    validate: (parsed: ParsedCommand) => {
      const action = parsed.named.action as RulesAction | undefined;
      if (!action) return `rules: name an action (${ACTIONS.join(" | ")})`;
      const target = (parsed.named.harness ?? harness) as InstallAgent;
      if (target !== harness) {
        return `rules ${action}: ${HARNESS_LABELS[target]} rules act from the ${HARNESS_LABELS[target]} page; open it first (:${target})`;
      }
      const reason = reasonFor(action);
      return reason === true ? null : `rules ${action}: ${reason}`;
    },
    run: (parsed: ParsedCommand) => run(parsed.named.action as RulesAction),
  };
  useCommands([rulesCommand]);

  return { error, run };
}
