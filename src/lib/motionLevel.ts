export type MotionLevel = "full" | "subtle" | "off";

/**
 * The effective motion level, read from `<html data-motion>`. Without the attribute it follows the legacy
 * reduce-motion setting and the OS preference (reduced motion = off), otherwise full. Read it when something is
 * about to move, not at import time.
 */
export function motionLevel(): MotionLevel {
  const root = document.documentElement;
  const value = root.dataset.motion;
  if (value === "full" || value === "subtle" || value === "off") return value;
  if (root.dataset.reduceMotion === "true") return "off";
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true ? "off" : "full";
}
