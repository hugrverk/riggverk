import { useEffect, useRef } from "react";
import { useMotion } from "../lib/motion";
import type { ActionResult } from "../types";

/** The class `.view-area` carries during the sweep, and the animation (`_shell.scss`) whose end removes it. */
const SCAN_CLASS = "scan";
const SCAN_ANIMATION = "view-scan";
/** The sweep lasts 520 ms; this is the safety net for an animation that never reports its end. */
const SCAN_FALLBACK_MS = 900;

/** Backend commands whose success is worth a flourish: an install, a rules conversion, a take bundled, a rollback. */
const SWEEP_COMMANDS = new Set(["apply_setup", "apply_rules_conversion", "apply_take_bundled", "apply_codex_config_defaults", "rollback_setup_transaction"]);

function earnsSweep(result: ActionResult | null): boolean {
  if (!result?.success) return false;
  // `apply_setup update claude`: the command, then the task's own label.
  const command = result.action.split(" ")[0] ?? "";
  return SWEEP_COMMANDS.has(command);
}

/**
 * When an apply or rollback succeeds, sweeps one accent line down the view area (full motion only). The sweep is
 * an overlay on `.view-area` that CSS draws while the `scan` class is on it: this hook only toggles the class
 * and removes it again when the animation ends. A result that was already there, a failure, a task still shown as
 * running and every other action do nothing.
 */
export function useScanOnSuccess(wsRunning: string | null, wsLog: ActionResult | null): void {
  const motion = useMotion();
  const shown = wsRunning ? null : wsLog;
  const seen = useRef(shown);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (seen.current === shown) return;
    seen.current = shown;
    if (motion !== "full" || !earnsSweep(shown)) return;
    const area = document.querySelector<HTMLElement>(".view-area");
    if (!area) return;
    const target: HTMLElement = area;

    stop.current?.();
    // Restart the animation when a sweep is still on screen.
    area.classList.remove(SCAN_CLASS);
    void area.offsetWidth;
    area.classList.add(SCAN_CLASS);

    const timer = window.setTimeout(finish, SCAN_FALLBACK_MS);
    function onEnd(event: AnimationEvent) {
      // Animations of the views inside bubble up here too.
      if (event.animationName === SCAN_ANIMATION) finish();
    }
    function finish() {
      window.clearTimeout(timer);
      target.removeEventListener("animationend", onEnd);
      target.classList.remove(SCAN_CLASS);
      stop.current = null;
    }
    target.addEventListener("animationend", onEnd);
    stop.current = finish;
  }, [shown, motion]);

  useEffect(() => () => stop.current?.(), []);
}
