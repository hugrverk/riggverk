import { useId } from "react";
import { dirtyTabAriaLabel } from "../lib/editorGuards";
import { DEFAULT_ENABLED_HARNESS_IDS, HARNESS_LABELS, HARNESS_NAV_ORDER } from "../lib/harnessInstallation";
import type { InstallAgent } from "../types";
import { VIEW_DIGITS, visibleViews, type AppView, type ViewDef } from "./views";

export interface SidebarProps {
  view: AppView;
  libraryDirty: boolean;
  settingsErrored: boolean;
  /** Agents shown in the sidebar. Defaults to the central three. */
  enabledHarnessIds?: readonly InstallAgent[];
  /** Items waiting for a decision per agent (`decideCountsByHarness`); agents without any show no badge. */
  decideCounts?: Partial<Record<InstallAgent, number>>;
  /** App version, shown in the brand row. */
  version?: string;
  /** Backups on disk; null while unknown. */
  backupCount?: number | null;
  /** When the installation status was last fetched; null before the first check. */
  checkedAt?: Date | null;
  onSwitchView: (view: AppView) => void | Promise<void>;
}

/** "Cursor", "Cursor and Copilot", "Cursor, Copilot and Pi". */
function listText(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** 24-hour "15:42", the way the foot line shows it. */
export function formatCheckedAt(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * 200px text sidebar: the brand row below the macOS traffic lights (the top 40px stay clear and drag the window),
 * Overview, the enabled agents, then History / Library / Settings. Each destination has a fixed digit key
 * (`VIEW_DIGITS`: it does not move when an agent is turned off) that shows only as `aria-keyshortcuts` and tooltip.
 * The current item draws a 2px hairline
 * (`::before`, scaleY). Markers: the count of decisions waiting per agent (read out as the item's description), a dot on Library (unsaved edits) and
 * Settings (failed autosave). Agents that are turned off collapse into one dim "N more agents" row leading to
 * Settings. The `shell-chrome` class is the focus hook the review panes use to tell that focus sits in the shell chrome.
 */
export function Sidebar({
  view,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = DEFAULT_ENABLED_HARNESS_IDS,
  decideCounts = {},
  version,
  backupCount = null,
  checkedAt = null,
  onSwitchView,
}: SidebarProps) {
  const baseId = useId();
  const defs = visibleViews(enabledHarnessIds);
  const overview = defs.filter(def => def.id === "start");
  const agents = defs.filter(def => def.harness !== undefined);
  const workspace = defs.filter(def => def.id !== "start" && def.harness === undefined);
  const disabledAgents = HARNESS_NAV_ORDER.filter(harness => !enabledHarnessIds.includes(harness));

  const item = (def: ViewDef) => {
    const dirty = (def.id === "library" && libraryDirty) || (def.id === "settings" && settingsErrored);
    const decide = def.harness ? (decideCounts[def.harness] ?? 0) : 0;
    const decideId = `${baseId}-${def.id}-decide`;
    const shortcut = VIEW_DIGITS[def.id];
    return (
      <button
        key={def.id}
        type="button"
        className="nav"
        aria-current={view === def.id ? "page" : undefined}
        aria-label={dirtyTabAriaLabel(dirty, def.label)}
        aria-describedby={decide > 0 ? decideId : undefined}
        aria-keyshortcuts={shortcut}
        title={shortcut ? `${def.label} (${shortcut})` : def.label}
        onClick={() => void onSwitchView(def.id)}
      >
        <span className="nav-label" aria-hidden="true">{def.label}</span>
        {decide > 0 && (
          <>
            <span className="nb" aria-hidden="true">{String(decide).padStart(2, "0")}</span>
            <span id={decideId} className="visually-hidden">{decide} to decide</span>
          </>
        )}
        {dirty && <span className="mark" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <aside className="side shell-chrome" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <b data-tauri-drag-region>Riggverk</b>
        {version && <span data-tauri-drag-region>{version}</span>}
      </div>
      <nav aria-label="Main navigation">
        {overview.map(item)}
        <div className="nl" aria-hidden="true">Agents</div>
        <div role="group" aria-label="Agents">
          {agents.map(item)}
          {disabledAgents.length > 0 && (
            <button
              type="button"
              className="nav dim"
              title={`${listText(disabledAgents.map(harness => HARNESS_LABELS[harness]))} ${disabledAgents.length === 1 ? "is" : "are"} off. Turn ${disabledAgents.length === 1 ? "it" : "them"} on in Settings.`}
              onClick={() => void onSwitchView("settings")}
            >
              <span className="nav-label">{disabledAgents.length} more {disabledAgents.length === 1 ? "agent" : "agents"}</span>
            </button>
          )}
        </div>
        <div className="nl" aria-hidden="true">Workspace</div>
        <div role="group" aria-label="Workspace">
          {workspace.map(item)}
        </div>
      </nav>
      <div className="foot" data-tauri-drag-region>
        {backupCount !== null && <span>{backupCount} backup{backupCount === 1 ? "" : "s"}</span>}
        {checkedAt && <span>checked {formatCheckedAt(checkedAt)}</span>}
      </div>
    </aside>
  );
}
