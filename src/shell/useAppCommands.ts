import { useCommands } from "../keyboard/commands/useCommands";
import type { CommandSpec, ParsedCommand } from "../keyboard/commands/parser";
import {
  describeUpdate,
  type InstallationOverview,
  type OverviewId,
} from "../hooks/useInstallationOverview";
import { HARNESS_NAV_ORDER } from "../lib/harnessInstallation";
import type { InstallTarget } from "../lib/installPlan";
import { WORKSPACE_FOLDER_UNUSABLE } from "../lib/installationView";
import { BUNDLED_RELEASES } from "../lib/releaseNotes";
import { workspaceTaskBlockedMessage } from "../lib/workspaceErrors";
import type { AppSettings, InstallAgent } from "../types";
import type { LibrarySourceType } from "../views/LibraryView";
import { useShellState } from "./ShellState";
import { VIEW_DEFS, type AppView } from "./views";

export interface AppCommandDeps {
  enabledHarnessIds: readonly InstallAgent[];
  dataFolderOk: boolean;
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
  /** Opens the uninstall preview dialog from the Overview's Workspace folder cell. */
  requestUninstallPreview: () => void | Promise<void>;
  /** `:workspace reset`: back to the default folder, after a confirm. Absent: the command only opens the page. */
  workspaceReset?: {
    reset: () => void | Promise<void>;
    /** No custom folder is saved (reset has nothing to do). */
    isDefault: boolean;
    /** A reset is already running. */
    busy: boolean;
  };
  setError: (message: string | null) => void;
}

const LIBRARY_SOURCES: LibrarySourceType[] = ["rules", "skills", "agents", "docs", "configs", "packs"];
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
  const { openHelp, openWhatsNew, notify } = useShellState();

  const targets = () => updateTargets(deps.enabledHarnessIds);
  const busyReason = () => (deps.busyLabel ? `${deps.busyLabel} is running` : true);
  const workspaceReason = () => (deps.dataFolderOk ? true : WORKSPACE_FOLDER_UNUSABLE);
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

  // With an unusable workspace folder only the workspace itself can be installed.
  const targetValues = (): OverviewId[] => (deps.dataFolderOk ? targets() : ["workspace"]);
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
    if (!deps.dataFolderOk && parsed.flags.all) return `${name}: ${WORKSPACE_FOLDER_UNUSABLE} (the Overview says why)`;
    return null;
  };

  const workspaceActions = ["reset"];
  const viewArgs = (def: (typeof VIEW_DEFS)[number]): CommandSpec["args"] => {
    if (def.id === "library") return [{ name: "source", kind: "enum", values: LIBRARY_SOURCES, optional: true }];
    if (def.id === "start" && deps.workspaceReset) {
      return [{
        name: "action",
        kind: "enum",
        values: workspaceActions,
        optional: true,
        describe: () => "back to the default workspace folder (asks first)",
      }];
    }
    return undefined;
  };

  const viewCommands = VIEW_DEFS.map((def): CommandSpec => ({
    name: def.command,
    aliases: def.aliases,
    summary: def.id === "start" && deps.workspaceReset ? `open ${def.label}, or reset its folder` : `open ${def.label}`,
    group: "Views",
    args: viewArgs(def),
    enabled: () =>
      def.harness && !deps.enabledHarnessIds.includes(def.harness) ? `${def.command} is hidden in Settings` : true,
    validate: def.id === "start"
      ? parsed => {
          const action = parsed.named.action;
          if (!action || !deps.workspaceReset) return null;
          if (deps.workspaceReset.busy) return "a workspace change is already running";
          if (deps.busyLabel) return workspaceTaskBlockedMessage(deps.busyLabel);
          if (deps.workspaceReset.isDefault) return "already the default workspace";
          return null;
        }
      : undefined,
    run: parsed => {
      if (def.id === "start" && parsed.named.action && deps.workspaceReset) {
        void deps.workspaceReset.reset();
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
      summary: "clear the last run result",
      group: "App",
      enabled: busyReason,
      run: () => deps.clearOutput(),
    },
    {
      name: "copy",
      summary: "copy the last run output (redacted) to the clipboard",
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
