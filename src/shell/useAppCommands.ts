import { useCommands } from "../keyboard/commands/useCommands";
import type { CommandSpec, ParsedCommand } from "../keyboard/commands/parser";
import {
  describeUpdate,
  type InstallationOverview,
  type OverviewId,
} from "../hooks/useInstallationOverview";
import { HARNESS_NAV_ORDER } from "../lib/harnessInstallation";
import type { InstallTarget } from "../lib/installPlan";
import { currentMotion } from "../lib/motion";
import { BUNDLED_RELEASES } from "../lib/releaseNotes";
import { workspaceTaskBlockedMessage } from "../lib/workspaceErrors";
import type { AppSettings, InstallAgent } from "../types";
import type { LibrarySourceType } from "../views/LibraryView";
import { useShellState } from "./ShellState";
import { VIEW_DEFS, type AppView } from "./views";

export interface AppCommandDeps {
  enabledHarnessIds: readonly InstallAgent[];
  workspaceValid: boolean;
  /** Label of the workspace task in flight (apply, uninstall, ...), or null. */
  busyLabel: string | null;
  overview?: InstallationOverview;
  /** The app's single navigation path. */
  switchView: (view: AppView) => void | Promise<void>;
  /** `:library <source>`. */
  setLibrarySource?: (source: LibrarySourceType) => void | Promise<void>;
  appearance: AppSettings["appearance"] | undefined;
  setAppearance: (appearance: AppSettings["appearance"]) => void;
  refresh: () => void | Promise<void>;
  openFolder: () => void;
  openBackups: () => void;
  clearOutput: () => void;
  /** Text of the last output (stdout + stderr), or null when there is none. */
  outputText: string | null;
  /**
   * Opens the install review on the target's page: previews, then asks y or n before anything is written.
   * `readOnly` shows the plan without an apply path. Surfaces whose target toggle is off are never part of it.
   */
  openInstall: (target: InstallTarget, options?: { readOnly?: boolean }) => void | Promise<void>;
  /** Transaction left by the last install or uninstall, if it can still be rolled back. */
  rollbackTransactionId: string | null;
  /** Dry run, confirm, then roll back `rollbackTransactionId`. */
  requestRollback: () => void | Promise<void>;
  /** Opens the uninstall preview dialog on the workspace page. */
  requestUninstallPreview: () => void | Promise<void>;
  /** `:workspace choose|reset`: switch the folder the app works in. Absent: the command only opens the page. */
  workspaceSwitch?: {
    choose: () => void | Promise<void>;
    reset: () => void | Promise<void>;
    /** No custom folder is saved (reset has nothing to do). */
    isDefault: boolean;
    /** A choose or reset is already running. */
    busy: boolean;
  };
  setError: (message: string | null) => void;
}

const LIBRARY_SOURCES: LibrarySourceType[] = ["docs", "rules", "skills", "agents", "configs"];
const APPEARANCES: AppSettings["appearance"][] = ["dark", "light", "system"];

function updateTargets(enabled: readonly InstallAgent[]): OverviewId[] {
  return ["workspace", ...HARNESS_NAV_ORDER.filter(harness => enabled.includes(harness))];
}

function isDarkNow(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/**
 * Global command set for `:` (view switches, theme, refresh, open, clear, copy, help, whatsnew,
 * update, preview, rollback, uninstall). Views add their own through `useCommands` while mounted.
 *
 * Mutating commands never write directly: `update` and `preview` open the install review (plan table, then
 * y to apply), `rollback` asks after a dry run, `uninstall` opens the existing uninstall preview.
 */
export function useAppCommands(deps: AppCommandDeps): void {
  const { openHelp, openWhatsNew, notify, replayBoot } = useShellState();

  const targets = () => updateTargets(deps.enabledHarnessIds);
  const busyReason = () => (deps.busyLabel ? `${deps.busyLabel} is running` : true);
  const workspaceReason = () => (deps.workspaceValid ? true : "no valid workspace installed");
  const guarded = (...checks: Array<() => true | string>) => (): true | string => {
    for (const check of checks) {
      const result = check();
      if (result !== true) return result;
    }
    return true;
  };
  const describeTarget = (value: string) => describeUpdate(deps.overview?.entries[value as OverviewId]?.status);

  const resolveTarget = (parsed: ParsedCommand): InstallTarget =>
    parsed.flags.all ? "all" : (parsed.named.target as InstallTarget);

  // Without a valid workspace only the workspace itself can be installed.
  const targetValues = (): OverviewId[] => (deps.workspaceValid ? targets() : ["workspace"]);
  const targetArgs: CommandSpec["args"] = [
    {
      name: "target",
      kind: "enum",
      values: targetValues,
      describe: describeTarget,
    },
    { name: "all", kind: "flag", description: "every enabled harness and the workspace" },
  ];
  const requireTarget = (parsed: ParsedCommand): string | null => {
    const name = parsed.cmd.name;
    if (!parsed.named.target && !parsed.flags.all) return `${name}: name a target (${targetValues().join(" | ")}) or pass --all`;
    if (parsed.named.target && parsed.flags.all) return `${name}: use either a target or --all`;
    if (!deps.workspaceValid && parsed.flags.all) return `${name}: no valid workspace installed (run ${name} workspace first)`;
    return null;
  };

  const workspaceActions = ["choose", "reset"];
  const viewArgs = (def: (typeof VIEW_DEFS)[number]): CommandSpec["args"] => {
    if (def.id === "library") return [{ name: "source", kind: "enum", values: LIBRARY_SOURCES, optional: true }];
    if (def.id === "start" && deps.workspaceSwitch) {
      return [{
        name: "action",
        kind: "enum",
        values: workspaceActions,
        optional: true,
        describe: value => (value === "choose" ? "pick the workspace folder" : "back to the default workspace"),
      }];
    }
    return undefined;
  };

  const viewCommands = VIEW_DEFS.map((def): CommandSpec => ({
    name: def.command,
    aliases: def.aliases,
    summary: def.id === "start" && deps.workspaceSwitch ? `open ${def.label}, or choose | reset its folder` : `open ${def.label}`,
    group: "Views",
    args: viewArgs(def),
    enabled: () =>
      def.harness && !deps.enabledHarnessIds.includes(def.harness) ? `${def.tab} is hidden in Settings` : true,
    validate: def.id === "start"
      ? parsed => {
          const action = parsed.named.action;
          if (!action || !deps.workspaceSwitch) return null;
          if (deps.workspaceSwitch.busy) return "a workspace change is already running";
          if (deps.busyLabel) return workspaceTaskBlockedMessage(deps.busyLabel);
          if (action === "reset" && deps.workspaceSwitch.isDefault) return "already the default workspace";
          return null;
        }
      : undefined,
    run: parsed => {
      if (def.id === "start" && parsed.named.action && deps.workspaceSwitch) {
        void (parsed.named.action === "reset" ? deps.workspaceSwitch.reset() : deps.workspaceSwitch.choose());
        return;
      }
      void deps.switchView(def.id);
      if (def.id === "library" && parsed.named.source) void deps.setLibrarySource?.(parsed.named.source as LibrarySourceType);
    },
  }));

  const commands: CommandSpec[] = [
    ...viewCommands,
    {
      name: "theme",
      summary: "set appearance: dark, light, system or toggle",
      group: "App",
      args: [{ name: "mode", kind: "enum", values: [...APPEARANCES, "toggle"] }],
      enabled: () => (deps.appearance === undefined ? "settings are still loading" : true),
      run: parsed => {
        const mode = parsed.named.mode;
        if (mode === "toggle") {
          const resolved = deps.appearance === "system" ? (isDarkNow() ? "dark" : "light") : deps.appearance;
          deps.setAppearance(resolved === "dark" ? "light" : "dark");
        } else {
          deps.setAppearance(mode as AppSettings["appearance"]);
        }
      },
    },
    {
      name: "refresh",
      summary: "reload workspace status and installation state",
      group: "App",
      run: () => deps.refresh(),
    },
    {
      name: "open",
      summary: "open the workspace folder or the backups folder",
      group: "App",
      args: [{ name: "what", kind: "enum", values: ["folder", "backups"] }],
      run: parsed => {
        if (parsed.named.what === "backups") deps.openBackups();
        else deps.openFolder();
      },
    },
    {
      name: "clear",
      summary: "clear the output pane",
      group: "App",
      enabled: busyReason,
      run: () => deps.clearOutput(),
    },
    {
      name: "copy",
      summary: "copy the output to the clipboard",
      group: "App",
      enabled: () => (deps.outputText ? true : "no output to copy"),
      run: async () => {
        try {
          await navigator.clipboard.writeText(deps.outputText ?? "");
          notify("copied output", { tone: "ok" });
        } catch {
          deps.setError("Copy failed: clipboard is not available");
        }
      },
    },
    {
      name: "help",
      summary: "show every key binding and command",
      group: "App",
      run: () => openHelp(),
    },
    {
      name: "whatsnew",
      summary: "show what changed in this and earlier releases",
      group: "App",
      enabled: () => (BUNDLED_RELEASES.length > 0 ? true : "this build has no release notes"),
      run: () => openWhatsNew({ releases: BUNDLED_RELEASES }),
    },
    {
      name: "boot",
      summary: "replay the launch sequence",
      group: "App",
      enabled: () => (currentMotion() === "full" ? true : "the launch sequence needs motion: full"),
      run: () => replayBoot(),
    },
    {
      name: "update",
      summary: "review what would change, then apply managed files (never overwrites conflicts)",
      group: "Workspace",
      args: targetArgs,
      validate: requireTarget,
      enabled: guarded(busyReason),
      run: parsed => void deps.openInstall(resolveTarget(parsed)),
    },
    {
      name: "preview",
      // `:p` was a unique prefix until `:pi` existed; an exact alias beats a prefix match.
      aliases: ["p"],
      summary: "show what update would change without applying",
      group: "Workspace",
      args: targetArgs,
      validate: requireTarget,
      run: parsed => void deps.openInstall(resolveTarget(parsed), { readOnly: true }),
    },
    {
      name: "rollback",
      summary: "restore the files of the last install or uninstall from its backup (dry run, then confirm)",
      group: "Workspace",
      enabled: guarded(busyReason, () =>
        deps.rollbackTransactionId ? true : "nothing to roll back in this session"),
      run: () => void deps.requestRollback(),
    },
    {
      name: "uninstall",
      summary: "remove app-installed files (opens the uninstall preview)",
      group: "Workspace",
      enabled: guarded(workspaceReason, busyReason),
      run: () => void deps.requestUninstallPreview(),
    },
  ];

  useCommands(commands);
}
