import type { CodexConfigKey, InstallationStatus } from "../types";
import type { StateDisplay } from "./installationView";

/** The surface that writes `$CODEX_HOME/config.toml`. */
export const CODEX_CONFIG_SURFACE = "codex_config";

/** The enforced Codex config keys the user keeps or could keep ("keep mine"), as the backend reports them. */
export interface CodexConfigModel {
  /** Kept: the installed value is the kept one. */
  kept: readonly CodexConfigKey[];
  /** Differ from what Riggverk writes and are not kept. */
  differing: readonly CodexConfigKey[];
}

/** The model of the Codex config under `status`, or null when it has no kept or keepable keys (or is not in the status). */
export function codexConfigModelFor(status: InstallationStatus | null | undefined): CodexConfigModel | null {
  const config = status?.surfaces.find(row => row.surface === CODEX_CONFIG_SURFACE)?.codex_config;
  if (!config || (config.kept.length === 0 && config.differing.length === 0)) return null;
  return { kept: config.kept, differing: config.differing };
}

/** "approvals_reviewer = auto_review, sandbox_mode = read-only". */
export function keyValueText(keys: readonly CodexConfigKey[]): string {
  return keys.map(({ key, value }) => `${key} = ${value}`).join(", ");
}

/** "approvals_reviewer", "approvals_reviewer and sandbox_mode", "a, b and c": key names only. */
export function keyNames(keys: readonly CodexConfigKey[]): string {
  const names = keys.map(({ key }) => key);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The surface row's label with the keys the user keeps: "current · you keep 1". */
export function withKeptKeys(display: StateDisplay, model: CodexConfigModel | null): StateDisplay {
  if (!model || model.kept.length === 0) return display;
  return {
    glyph: display.glyph === "ok" ? "partial" : display.glyph,
    tone: display.tone === "ok" ? "warn" : display.tone,
    label: `${display.label} · you keep ${model.kept.length}`,
  };
}

/** Whether an action is offered (`visible`) and, when it is offered but cannot run now, why not (`reason`). */
export interface CodexConfigGate {
  visible: boolean;
  reason: string | null;
}

export interface CodexConfigGates {
  /** `m` while enforced keys differ: keep my values. */
  keep: CodexConfigGate;
  /** `m` while keys are kept and none other differs: hand them back. */
  handBack: CodexConfigGate;
}

export interface CodexConfigGateContext {
  dataFolderOk: boolean;
  /** Label of a workspace task in flight, or null. */
  busyLabel: string | null;
  /** A review is open on the page: the actions wait for it to close. */
  blockedBy: string | null;
}

/**
 * What `m` may do for `model` right now. One key, two meanings: keep the differing values, or (when everything that
 * differs is already kept) hand the kept keys back to Riggverk.
 */
export function codexConfigGates(model: CodexConfigModel | null, context: CodexConfigGateContext): CodexConfigGates {
  const hidden: CodexConfigGate = { visible: false, reason: null };
  if (!model || !context.dataFolderOk) return { keep: hidden, handBack: hidden };
  const wait = context.blockedBy ?? (context.busyLabel ? `${context.busyLabel} is running` : null);
  const gate = (visible: boolean): CodexConfigGate => ({ visible, reason: visible ? wait : null });
  const keep = model.differing.length > 0;
  return { keep: gate(keep), handBack: gate(!keep && model.kept.length > 0) };
}

/** The confirm that keeping asks first. */
export function keepMessage(differing: readonly CodexConfigKey[]): string {
  return `Keep your value for ${keyValueText(differing)}? Riggverk stops proposing changes to ${differing.length === 1 ? "it" : "them"} and never writes ${differing.length === 1 ? "it" : "them"} while the value stays as it is. The other managed keys keep following Riggverk. Press m again to hand ${differing.length === 1 ? "it" : "them"} back.`;
}
