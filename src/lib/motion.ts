import { useSyncExternalStore } from "react";

/** Motion level. "off" also stands in for the OS reduced-motion preference. */
export type MotionLevel = "full" | "subtle" | "off";

export const MOTION_VALUES: readonly MotionLevel[] = ["full", "subtle", "off"];

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Unknown or missing values fall back to "full", mirroring the backend. */
export function normalizeMotion(value: unknown): MotionLevel {
  return MOTION_VALUES.includes(value as MotionLevel) ? (value as MotionLevel) : "full";
}

/** The OS preference wins: a reduced-motion request means "off" whatever the setting says. */
export function effectiveMotion(setting: unknown, osReduced: boolean): MotionLevel {
  return osReduced ? "off" : normalizeMotion(setting);
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

/** The level in force right now, as `applyMotionSetting` last wrote it to `<html data-motion>`. */
export function currentMotion(): MotionLevel {
  if (typeof document === "undefined") return "full";
  const attribute = document.documentElement.dataset.motion;
  // Before the first apply the attribute is absent; the OS preference still holds.
  return attribute ? normalizeMotion(attribute) : effectiveMotion("full", reducedMotionQuery()?.matches === true);
}

let stopWatchingOsPreference: (() => void) | null = null;

/**
 * Writes the effective level to `<html data-motion>` and keeps it current when the OS preference changes.
 * Called from `applyThemeSettings`; each call replaces the previous watcher.
 */
export function applyMotionSetting(setting: unknown): void {
  stopWatchingOsPreference?.();
  stopWatchingOsPreference = null;
  const query = reducedMotionQuery();
  const write = () => {
    document.documentElement.setAttribute("data-motion", effectiveMotion(setting, query?.matches === true));
  };
  write();
  if (query?.addEventListener) {
    query.addEventListener("change", write);
    stopWatchingOsPreference = () => query.removeEventListener("change", write);
  }
}

function subscribeToMotion(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => observer.disconnect();
}

/** The effective motion level; re-renders when the setting or the OS preference changes it. */
export function useMotion(): MotionLevel {
  return useSyncExternalStore(subscribeToMotion, currentMotion, () => "full");
}
