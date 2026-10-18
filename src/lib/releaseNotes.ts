import bundled from "../generated/release-notes.json";

/** One heading of a release's notes ("New", "Fixes", ...), with its items as plain text. */
export interface ReleaseNotesSection {
  title: string;
  items: string[];
}

/** The notes of one release, as `scripts/generate-release-notes.py` bundles them. */
export interface ReleaseNotes {
  version: string;
  sections: ReleaseNotesSection[];
}

/** What the "what's new" overlay shows, and what to do once it is closed. */
export interface WhatsNewRequest {
  releases: readonly ReleaseNotes[];
  onClose?: () => void;
}

/** Every release the build knows notes for, newest first. */
export const BUNDLED_RELEASES: readonly ReleaseNotes[] = bundled.releases;

function parts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative, zero or positive like a sort comparator; null when either side is not a plain `N.N.N` version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return null;
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Notes for the releases after `lastSeen` up to `current`, newest first. */
export function releasesSince(
  releases: readonly ReleaseNotes[],
  lastSeen: string,
  current: string,
): ReleaseNotes[] {
  return releases
    .filter(release => {
      const afterLastSeen = compareVersions(release.version, lastSeen);
      const upToCurrent = compareVersions(release.version, current);
      return afterLastSeen !== null && upToCurrent !== null && afterLastSeen > 0 && upToCurrent <= 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0);
}
