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
  /** What Riggverk writes for each kept and differing key; absent from an older backend (the value is then not told). */
  expected?: readonly CodexConfigKey[];
}

/**
 * The keys Riggverk manages in `config.toml` (the backend's `CODEX_KEEPABLE_PATHS`). The status only names the ones the
 * user keeps or that differ; the table lists the rest as following Riggverk.
 */
export const CODEX_MANAGED_KEYS: readonly string[] = [
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "apps._default.approvals_reviewer",
  "apps._default.default_tools_approval_mode",
];

/** The keys the user chose and Riggverk never compares, told under the table. */
export const CODEX_CREATE_ONLY_NOTE = "model and model_reasoning_effort are yours after the first install and are never compared.";

/** The model of the Codex config under `status`, or null when it has no kept or keepable keys (or is not in the status). */
export function codexConfigModelFor(status: InstallationStatus | null | undefined): CodexConfigModel | null {
  const config = status?.surfaces.find(row => row.surface === CODEX_CONFIG_SURFACE)?.codex_config;
  if (!config || (config.kept.length === 0 && config.differing.length === 0)) return null;
  return { kept: config.kept, differing: config.differing, expected: config.expected };
}

export interface CodexKeyRow {
  key: string;
  /** Riggverk's value, or null when the backend does not tell it (a key that follows Riggverk, an older backend). */
  riggverk: string | null;
  /** The value in the user's file, or null for a key that matches Riggverk's. */
  yours: string | null;
  /** `differs`: not kept, not Riggverk's. `kept`: the user's choice. `same`: follows Riggverk. */
  state: "differs" | "kept" | "same";
}

/**
 * The table of the Codex decision: the differing keys first, then the kept ones, then the managed keys that follow
 * Riggverk. A key the backend names twice (kept and differing) shows once, as differing.
 */
export function codexKeyRows(model: CodexConfigModel): CodexKeyRow[] {
  const riggverk = (key: string) => (model.expected ?? []).find(item => item.key === key)?.value ?? null;
  const differing = model.differing.map((item): CodexKeyRow => ({ key: item.key, riggverk: riggverk(item.key), yours: item.value, state: "differs" }));
  const named = new Set(differing.map(row => row.key));
  const kept = model.kept
    .filter(item => !named.has(item.key))
    .map((item): CodexKeyRow => ({ key: item.key, riggverk: riggverk(item.key), yours: item.value, state: "kept" }));
  kept.forEach(row => named.add(row.key));
  const same = CODEX_MANAGED_KEYS.filter(key => !named.has(key)).map((key): CodexKeyRow => ({ key, riggverk: null, yours: null, state: "same" }));
  return [...differing, ...kept, ...same];
}

/** The sentence above the Codex table: what Riggverk did with the keys and what Codex runs with. */
export function codexWhy(model: CodexConfigModel): string {
  const total = CODEX_MANAGED_KEYS.length;
  if (model.differing.length > 0) {
    const count = model.differing.length;
    return `Riggverk manages ${total} keys in this file. ${count === 1 ? "One differs" : `${count} differ`} from Riggverk's default, so it changed nothing. Codex runs with your values.`;
  }
  return `You keep ${keyNames(model.kept)}, so Riggverk never writes ${model.kept.length === 1 ? "it" : "them"}. It manages the other keys as before. Codex runs with your values.`;
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
  /** `b` while enforced keys differ: preview setting them to Riggverk's values. */
  defaults: CodexConfigGate;
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
  if (!model || !context.dataFolderOk) return { keep: hidden, handBack: hidden, defaults: hidden };
  const wait = context.blockedBy ?? (context.busyLabel ? `${context.busyLabel} is running` : null);
  const gate = (visible: boolean): CodexConfigGate => ({ visible, reason: visible ? wait : null });
  const keep = model.differing.length > 0;
  return { keep: gate(keep), handBack: gate(!keep && model.kept.length > 0), defaults: gate(keep) };
}

/** The confirm that keeping asks first. */
export function keepMessage(differing: readonly CodexConfigKey[]): string {
  return `Keep your value for ${keyValueText(differing)}? Riggverk stops proposing changes to ${differing.length === 1 ? "it" : "them"} and never writes ${differing.length === 1 ? "it" : "them"} while the value stays as it is. The other managed keys keep following Riggverk. Press m again to hand ${differing.length === 1 ? "it" : "them"} back.`;
}
