import type { KvItem } from "../ui/Kv";
import type { Tone } from "../ui/tone";
import type { FindingCode, PostureFinding, PostureLevel, SecurityPosture } from "../types";
import { postureMark } from "./uiState";

export interface PostureVerdict {
  text: string;
  tone: Tone;
}

/** The verdict when the posture could not be loaded at all. */
export const POSTURE_UNAVAILABLE: PostureVerdict = { text: "could not read config", tone: "dim" };

const LEVEL_WORDS: Record<PostureLevel, string> = {
  risky: "risky",
  enforced: "enforced",
  advice: "advice only",
  not_covered: "not covered",
};

const LEVEL_ORDER: readonly PostureLevel[] = ["risky", "enforced", "advice", "not_covered"];

const LEVEL_TONES: Record<PostureLevel, Tone | undefined> = {
  risky: "warn",
  enforced: undefined,
  advice: "dim",
  not_covered: "dim",
};

interface Copy {
  label: string;
  text: (finding: PostureFinding) => string;
}

const fixed = (label: string, text: string): Copy => ({ label, text: () => text });

const plural = (count: number | null, one: string, many: string): string => `${count ?? 0} ${count === 1 ? one : many}`;

/**
 * The phrase of every finding code. `enforced` only ever means "set in the config file read": the check cannot see
 * project or managed config, profiles, flags or aliases, so no phrase says secure, safe or all good. The Rust parity
 * test (`security_posture.rs`) requires a key here for every backend code.
 */
const COPY: Record<FindingCode, Copy> = {
  claude_bypass_default: fixed("bypass mode", "starts in bypassPermissions mode: no permission prompts"),
  claude_bypass_disabled: fixed("bypass mode", "blocked by permissions.disableBypassPermissionsMode"),
  claude_bypass_available: fixed("bypass mode", "can be switched on; permissions.disableBypassPermissionsMode is not set"),
  claude_sandbox_on: fixed(
    "sandbox",
    "sandbox.enabled is true · covers shell commands only; file tools, MCP servers and hooks run outside it",
  ),
  claude_sandbox_off: fixed("sandbox", "sandbox.enabled is not true · shell commands run without the OS sandbox"),
  claude_env_read_denied: fixed(".env reads", "a Read deny rule names .env · matches the tool call, not other programs"),
  claude_env_read_open: fixed(".env reads", "no Read deny rule names .env in permissions.deny"),
  claude_config_dir_set: fixed("scope", "CLAUDE_CONFIG_DIR is set · Claude reads its settings there; not checked"),
  codex_no_sandbox: fixed("sandbox", "sandbox_mode is danger-full-access · no OS sandbox"),
  codex_sandbox_workspace: fixed("sandbox", "sandbox_mode is workspace-write"),
  codex_sandbox_read_only: fixed("sandbox", "sandbox_mode is read-only"),
  codex_sandbox_unset: fixed("sandbox", "sandbox_mode is not set · Codex picks its own default"),
  codex_approvals_never: fixed("approvals", "approval_policy is never · commands run without asking, inside the sandbox mode"),
  codex_approvals_on_request: fixed("approvals", "approval_policy is on-request"),
  codex_network_on: fixed("network", "network_access is true in [sandbox_workspace_write] · commands can reach the network"),
  codex_trusted_projects: {
    label: "trusted",
    text: finding =>
      `${plural(finding.count, "project", "projects")} marked trusted · Codex loads their .codex/config.toml without asking`,
  },
  opencode_allow_all: {
    label: "permission",
    text: finding => `"*" is allow in ${finding.file ?? "the config"} · everything runs without asking`,
  },
  opencode_bash_allow: {
    label: "bash",
    text: finding => `permission.bash is allow in ${finding.file ?? "the config"} · shell commands run without asking`,
  },
  opencode_deny_rules: {
    label: "deny rules",
    text: finding =>
      `${plural(finding.count, "deny rule", "deny rules")} under permission.bash and permission.read · matched against command text, not an OS sandbox`,
  },
  opencode_deny_rules_missing: fixed(
    "deny rules",
    "none under permission.bash or permission.read in opencode.json · the config row shows drift",
  ),
  cursor_sandbox_off: fixed("sandbox", "sandbox.json type is insecure_none · sandbox off"),
  cursor_network_open: fixed("network", "sandbox.json networkPolicy.default is allow · sandboxed commands can reach any host"),
  cursor_run_mode: fixed(
    "run mode",
    "set in Settings > Agents > Approvals & Execution, not in a file Riggverk reads; Run Everything has no sandbox",
  ),
  kilo_allow_all: { label: "permission", text: finding => `"*" is allow in ${finding.file ?? "the config"}` },
  kilo_bash_allow: { label: "bash", text: finding => `permission.bash is allow in ${finding.file ?? "the config"}` },
  kilo_no_rules: fixed("permission", "Riggverk writes no permission rules for Kilo"),
  copilot_not_covered: fixed(
    "controls",
    "Riggverk reads no Copilot setting · --allow-all-tools, --yolo and /yolo apply per session and cannot be seen; GitHub suggests a VM or container for unattended runs",
  ),
  pi_not_covered: fixed("controls", "Riggverk reads no Pi setting and writes none · run Pi in a container or VM"),
  config_only: fixed("not checked", "project and managed config, profiles, command-line flags and aliases"),
};

function verdictOf(posture: SecurityPosture): PostureVerdict {
  const risky = posture.findings.filter(finding => finding.level === "risky").length;
  if (risky > 0) return { text: `${risky} risky`, tone: "warn" };
  const { sources } = posture;
  if (sources.length === 0) return { text: "not covered", tone: "dim" };
  const unreadable = sources.find(source => source.state === "unreadable");
  if (unreadable) return { text: `could not read ${unreadable.file}`, tone: "dim" };
  const read = sources.filter(source => source.state === "read");
  if (read.length > 0) {
    return { text: `no risky settings found in ${read.map(source => source.file).join(", ")} · this checks config only`, tone: "dim" };
  }
  if (sources.every(source => source.state === "missing")) {
    return { text: `no ${sources[0].file} · defaults apply · config only`, tone: "dim" };
  }
  return { text: "not checked", tone: "dim" };
}

/** The `security` group of a harness page: a verdict that never says secure, and one row per finding. */
export function postureRowsFor(posture: SecurityPosture): { verdict: PostureVerdict; rows: KvItem[] } {
  const rank = (finding: PostureFinding): number =>
    finding.code === "config_only" ? LEVEL_ORDER.length : LEVEL_ORDER.indexOf(finding.level);
  const ordered = posture.findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => rank(a.finding) - rank(b.finding) || a.index - b.index)
    .map(entry => entry.finding);
  const rows: KvItem[] = ordered.map(finding => {
    const copy = COPY[finding.code];
    return {
      label: copy.label,
      value: `${LEVEL_WORDS[finding.level]} · ${copy.text(finding)}`,
      tone: LEVEL_TONES[finding.level],
      wrap: true,
      id: finding.code,
    };
  });
  rows.push({ label: "baseline", value: "Library > Docs > Security Baseline", tone: "dim", id: "baseline" });
  return { verdict: verdictOf(posture), rows };
}

export interface PostureNote {
  id: string;
  label: string;
  /** What the finding says, without the level word: the mark carries the level. */
  text: string;
  /** "Worth a look", "Tip" or "Set"; null for what is not checked. */
  mark: { text: string; kind: "tip" | "set" } | null;
}

/**
 * The "Safety notes" zone of a harness page: the same verdict and findings as `postureRowsFor`, in the same order, with
 * the mark each level gets (`postureMark`) instead of the level word. Advice only: nothing here is a state or counted.
 */
export function postureNotesFor(posture: SecurityPosture): { verdict: PostureVerdict; notes: PostureNote[] } {
  const rank = (finding: PostureFinding): number =>
    finding.code === "config_only" ? LEVEL_ORDER.length : LEVEL_ORDER.indexOf(finding.level);
  const notes = posture.findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => rank(a.finding) - rank(b.finding) || a.index - b.index)
    .map(({ finding }): PostureNote => {
      const copy = COPY[finding.code];
      return { id: finding.code, label: copy.label, text: copy.text(finding), mark: postureMark(finding.level) };
    });
  notes.push({ id: "baseline", label: "baseline", text: "Library > Docs > Security Baseline", mark: null });
  return { verdict: verdictOf(posture), notes };
}

/**
 * One short phrase per risky finding, in report order: the finding's text up to its first " · " (what is set, not the
 * caveat). The Overview's "Worth a look" cell shows them; the harness page keeps the full rows.
 */
export function riskyFindingPhrases(posture: SecurityPosture): string[] {
  return posture.findings
    .filter(finding => finding.level === "risky")
    .map(finding => COPY[finding.code].text(finding).split(" · ")[0]!);
}
