import { invoke } from "@tauri-apps/api/core";
import type { ActionResult } from "../types";

/**
 * Runs an `open_*` command. The backend answers `Ok(success: false)` when the OS opener
 * fails (e.g. no default app for the file type), which `invoke` does not reject on, so a
 * soft failure is surfaced here together with a rejected call.
 */
export async function invokeOpen(
  command: string,
  args: Record<string, unknown> | undefined,
  label: string,
  setError: (message: string) => void,
): Promise<void> {
  try {
    const result = await invoke<ActionResult>(command, args);
    if (!result.success) {
      setError(`${label}: ${result.stderr.trim() || "could not open"}`);
    }
  } catch (e) {
    setError(`${label}: ${e}`);
  }
}
