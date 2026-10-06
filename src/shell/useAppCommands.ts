import { useConfirm } from "../components/ConfirmDialog";
import { useCommands } from "../keyboard/commands/useCommands";
import type { CommandSpec, ParsedCommand } from "../keyboard/commands/parser";
import {
  describeUpdate,
  surfacesForOverview,
  type InstallationOverview,
  type OverviewId,
} from "../hooks/useInstallationOverview";
import { HARNESS_NAV_ORDER, surfacesNeedingApply } from "../lib/harnessInstallation";
import type { AppSettings, InstallAgent, SetupPlan, SetupSurfaceId } from "../types";
import type { LibrarySourceType } from "../views/LibraryView";
import { useShellState } from "./ShellState";
import { VIEW_DEFS, type AppView } from "./views";

export interface AppCommandDeps {
  enabledHarnessIds: readonly InstallAgent[];
  workspaceValid: boolean;
  /** Label of the workspace task in flight (apply, release-check, ...), or null. */
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
  canRunReleaseCheck: boolean;
  runReleaseCheck: () => void;
  previewSetup: (surfaces: SetupSurfaceId[]) => Promise<SetupPlan>;
  /** Existing apply path (preview + apply behind the reviewed fingerprint). */
  runUpdate: (surfaces: string[], label: string) => void;
  /** Transaction left by the last uninstall, if it can still be rolled back. */
  rollbackTransactionId: string | null;
  runRollback: () => Promise<boolean> | void;
  setError: (message: string | null) => void;
}

const LIBRARY_SOURCES: LibrarySourceType[] = ["docs", "rules", "skills", "agents", "configs", "brain"];
const APPEARANCES: AppSettings["appearance"][] = ["dark", "light", "system"];

function updateTargets(enabled: readonly InstallAgent[]): OverviewId[] {
  return ["workspace", ...HARNESS_NAV_ORDER.filter(harness => enabled.includes(harness))];
}

function isDarkNow(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/**
 * Global command set for `:` (view switches, theme, refresh, open, clear, copy, help, release-check,
 * update, preview, rollback, uninstall). Views add their own through `useCommands` while mounted.
 *
 * Mutating commands never write directly. Interim (until the plan screen lands): `update` previews, then asks
 * through the existing confirm dialog with the plan summary, then runs the existing apply path.
 */
export function useAppCommands(deps: AppCommandDeps): void {
  const confirm = useConfirm();
  const { openHelp, notify, beginConfirm } = useShellState();

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

  const resolveTargets = (parsed: ParsedCommand): { ids: OverviewId[]; label: string } => {
    if (parsed.flags.all) return { ids: targets(), label: "all" };
    const id = parsed.named.target as OverviewId;
    return { ids: [id], label: id };
  };
  const surfacesOf = (ids: OverviewId[]): SetupSurfaceId[] => [...new Set(ids.flatMap(surfacesForOverview))];

  const targetArgs: CommandSpec["args"] = [
    {
      name: "target",
      kind: "enum",
      values: () => targets(),
      describe: describeTarget,
    },
    { name: "all", kind: "flag", description: "every enabled harness and the workspace" },
  ];
  const requireTarget = (parsed: ParsedCommand): string | null => {
    const name = parsed.cmd.name;
    if (!parsed.named.target && !parsed.flags.all) return `${name}: name a target (${targets().join(" | ")}) or pass --all`;
    if (parsed.named.target && parsed.flags.all) return `${name}: use either a target or --all`;
    return null;
  };

  const viewCommands = VIEW_DEFS.map((def): CommandSpec => ({
    name: def.command,
    aliases: def.aliases,
    summary: `open ${def.label}`,
    group: "Views",
    args: def.id === "library" ? [{ name: "source", kind: "enum", values: LIBRARY_SOURCES, optional: true }] : undefined,
    enabled: () =>
      def.harness && !deps.enabledHarnessIds.includes(def.harness) ? `${def.tab} is hidden in Settings` : true,
    run: parsed => {
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
          notify("copied output");
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
      name: "release-check",
      aliases: ["rc"],
      summary: "run the workspace release check",
      group: "Workspace",
      enabled: guarded(workspaceReason, busyReason, () => (deps.canRunReleaseCheck ? true : "release-check is not available in this workspace")),
      run: () => deps.runReleaseCheck(),
    },
    {
      name: "update",
      summary: "preview, then apply managed files (never overwrites conflicts)",
      group: "Workspace",
      args: targetArgs,
      validate: requireTarget,
      enabled: guarded(workspaceReason, busyReason),
      run: async parsed => {
        const { ids, label } = resolveTargets(parsed);
        const surfaces = surfacesOf(ids);
        const plan = await deps.previewSetup(surfaces);
        const conflicts = plan.conflicts.length;
        if (surfacesNeedingApply(plan).length === 0 || !plan.plan_fingerprint || !plan.preview_token) {
          notify(`update ${label}: nothing to apply${conflicts > 0 ? `, ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : ""}`);
          return;
        }
        const release = beginConfirm();
        let approved = false;
        try {
          approved = await confirm({
            title: `Update ${label}`,
            message: plan.summary,
            confirmLabel: "update",
          });
        } finally {
          release();
        }
        if (approved) deps.runUpdate(surfaces, `${label} update`);
      },
    },
    {
      name: "preview",
      summary: "show what update would change without applying",
      group: "Workspace",
      args: targetArgs,
      validate: requireTarget,
      enabled: guarded(workspaceReason),
      run: async parsed => {
        const { ids, label } = resolveTargets(parsed);
        const plan = await deps.previewSetup(surfacesOf(ids));
        notify(`preview ${label}: ${plan.summary}`, 8000);
      },
    },
    {
      name: "rollback",
      summary: "restore the files removed by the last uninstall",
      group: "Workspace",
      enabled: guarded(busyReason, () =>
        deps.rollbackTransactionId ? true : "no uninstall to roll back in this session"),
      run: async () => {
        const release = beginConfirm();
        let approved = false;
        try {
          approved = await confirm({
            title: "Roll back uninstall",
            message: `Restore the files removed by the last uninstall (transaction ${deps.rollbackTransactionId}) from backup?`,
            confirmLabel: "roll back",
          });
        } finally {
          release();
        }
        if (approved) await deps.runRollback();
      },
    },
    {
      name: "uninstall",
      summary: "remove app-installed files (opens the uninstall preview)",
      group: "Workspace",
      enabled: guarded(workspaceReason, busyReason),
      run: async () => {
        await deps.switchView("start");
        notify("uninstall: use the Uninstall card on the workspace page to preview and confirm");
      },
    },
  ];

  useCommands(commands);
}
