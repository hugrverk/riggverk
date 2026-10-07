export type MotionLevel = "full" | "subtle" | "off";

/**
 * The effective motion level, read from `<html data-motion>`. Without the attribute it follows the OS
 * preference (reduced motion = off), otherwise full. Read it when something is about to move, not at import time.
 */
export function motionLevel(): MotionLevel {
  const value = document.documentElement.dataset.motion;
  if (value === "full" || value === "subtle" || value === "off") return value;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true ? "off" : "full";
}
