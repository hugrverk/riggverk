import { useEffect, useRef } from "react";
import { BUNDLED_RELEASES, compareVersions, releasesSince, type ReleaseNotes } from "../lib/releaseNotes";
import { useShellState } from "../shell/ShellState";
import type { AppSettings } from "../types";

interface WhatsNewOnUpgradeOptions {
  /** The loaded settings; null until they are. */
  settings: AppSettings | null;
  /** Version of this build. */
  appVersion: string;
  /** Records `version` as seen (an autosaved setting). */
  recordVersion: (version: string) => void;
  releases?: readonly ReleaseNotes[];
}

/**
 * First launch after an update: opens the "what's new" overlay once with the notes of the releases since the
 * last seen version, and records this version when it is closed. A fresh install (nothing recorded yet) only
 * records the version. The same or an older version, or no notes for the versions in between, change nothing
 * visible. Decides once per launch, as soon as the settings have loaded.
 */
export function useWhatsNewOnUpgrade({
  settings,
  appVersion,
  recordVersion,
  releases = BUNDLED_RELEASES,
}: WhatsNewOnUpgradeOptions): void {
  const { openWhatsNew } = useShellState();
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || !settings) return;
    decided.current = true;
    const lastSeen = settings.last_seen_version;
    if (!lastSeen) {
      recordVersion(appVersion);
      return;
    }
    const newer = compareVersions(appVersion, lastSeen);
    if (newer === null || newer <= 0) return;
    const unseen = releasesSince(releases, lastSeen, appVersion);
    if (unseen.length === 0) {
      recordVersion(appVersion);
      return;
    }
    openWhatsNew({ releases: unseen, onClose: () => recordVersion(appVersion) });
  }, [settings, appVersion, recordVersion, releases, openWhatsNew]);
}
