import { vi } from "vitest";
import type { EffectiveSkillLoadsState } from "../hooks/useEffectiveSkillLoads";
import type { InstallationOverview, OverviewEntry, OverviewId } from "../hooks/useInstallationOverview";
import { buildInstallReview, type InstallFlow, type InstallFlowRequest } from "../hooks/useInstallFlow";
import type { InstallScreen } from "../hooks/useInstallScreen";
import type { AppView } from "../shell/views";
import type {
  AppSettings,
  EffectiveSkillLoads,
  InstallationState,
  InstallationStatus,
  PlannedOperation,
  PostureFinding,
  PostureSource,
  SecurityPosture,
  SetupPlan,
  SetupSurfaceId,
  StatusData,
  SurfaceInstallationStatus,
  WorkspaceDiagnostics,
} from "../types";
import { defaultSettings } from "../lib/settingsDraft";

export const VALID_DIAGNOSTICS: WorkspaceDiagnostics = {
  candidate_path: "/tmp/workspace",
  resolved_path: "/tmp/workspace",
  valid: true,
  error: null,
  enabled_rule_targets: 3,
  total_rule_targets: 3,
  enabled_config_targets: 1,
  total_config_targets: 2,
  backup_root: "/tmp/backups",
  backup_root_exists: true,
};

export const INVALID_DIAGNOSTICS: WorkspaceDiagnostics = {
  ...VALID_DIAGNOSTICS,
  resolved_path: null,
  valid: false,
  error: "the folder is a symlink",
};

export const STATUS_DATA = {
  repo_path: "/tmp/workspace",
  enabled_rule_target_ids: ["codex_rules", "claude_rules", "opencode_rules"],
  enabled_config_target_ids: ["opencode_config"],
} as unknown as StatusData;

export function surfaceStatus(surface: SetupSurfaceId, state: InstallationState, detail = `${state} detail`): SurfaceInstallationStatus {
  return { surface, label: surface, state, detail };
}

export function installationStatus(
  state: InstallationState,
  surfaces: SurfaceInstallationStatus[] = [],
  counts: Partial<InstallationStatus["counts"]> = {},
  extra: Partial<InstallationStatus> = {},
): InstallationStatus {
  return {
    state,
    summary: state === "current" ? "Current" : `${state} summary`,
    counts: { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 0, ...counts },
    surfaces,
    ...extra,
  };
}

export function overviewOf(statuses: Partial<Record<OverviewId, InstallationStatus | null>>): InstallationOverview {
  const entries: Partial<Record<OverviewId, OverviewEntry>> = {};
  for (const [id, status] of Object.entries(statuses) as Array<[OverviewId, InstallationStatus | null]>) {
    entries[id] = { id, status, loading: false, error: null };
  }
  return { entries, loading: false, refresh: vi.fn(async () => {}) };
}

/** The skill-load state a page receives: loaded `loads`, or none yet. */
export function skillLoadsOf(loads: EffectiveSkillLoads | null = null, error: string | null = null): EffectiveSkillLoadsState {
  return { loads, loading: false, error, refresh: vi.fn(async () => {}) };
}

export function settingsOf(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), workspace_path: "/tmp/workspace", ...overrides };
}

export function op(surface: SetupSurfaceId, kind: PlannedOperation["kind"], extra: Partial<PlannedOperation> = {}): PlannedOperation {
  return { surface, kind, summary: `${kind} ${surface}`, ...extra };
}

export function planOf(operations: PlannedOperation[]): SetupPlan {
  const pending = operations.some(o => o.kind === "create" || o.kind === "update" || o.kind === "remove");
  return {
    operations,
    synced: [],
    conflicts: operations.filter(o => o.kind === "conflict"),
    manual_steps: [],
    summary: "",
    has_pending_changes: pending,
    is_blocked: false,
    plan_fingerprint: pending ? "fp-1" : null,
    preview_token: pending ? "tok-1" : null,
  };
}

/** An idle install flow, or one in `review` for `operations`. */
export function flowOf(operations?: PlannedOperation[], request: InstallFlowRequest = { label: "update claude", surfaces: ["claude_rules"] }): InstallFlow {
  const review = operations ? buildInstallReview(request, planOf(operations)) : null;
  return {
    status: review ? "review" : "idle",
    request: review ? request : null,
    review,
    error: null,
    outcome: null,
    start: vi.fn(async () => null),
    apply: vi.fn(async () => null),
    cancel: vi.fn(),
    repreview: vi.fn(async () => null),
  };
}

/** An `InstallScreen` whose review shows on `openOn` when the flow is not idle. */
export function installScreenOf(flow: InstallFlow = flowOf(), openOn: AppView | null = null): InstallScreen {
  return {
    flow,
    scope: openOn === "start" ? "start" : openOn === null ? null : (openOn as InstallScreen["scope"]),
    isOpenOn: (view: AppView) => openOn === view && flow.status !== "idle",
    open: vi.fn(async () => {}),
    apply: vi.fn(),
  };
}

/** A security posture as the backend returns it: `findings` as [code, level] pairs or full findings, one read source by default. */
export function postureOf(
  harness: SecurityPosture["harness"],
  findings: ReadonlyArray<readonly [PostureFinding["code"], PostureFinding["level"]] | PostureFinding> = [],
  sources: PostureSource[] = [{ file: "~/.config/file.json", state: "read" }],
): SecurityPosture {
  return {
    harness,
    sources,
    findings: findings.map(finding =>
      Array.isArray(finding) ? { code: finding[0], level: finding[1], file: null, count: null } : (finding as PostureFinding),
    ),
  };
}

/** Claude with bypass mode as the starting mode. */
export const RISKY_CLAUDE = postureOf(
  "claude",
  [["claude_bypass_default", "risky"], ["claude_sandbox_off", "advice"], ["claude_env_read_open", "advice"], ["config_only", "not_covered"]],
  [{ file: "~/.claude/settings.json", state: "read" }],
);

/** Codex with nothing risky in its config. */
export const CLEAN_CODEX = postureOf(
  "codex",
  [["codex_sandbox_workspace", "enforced"], ["codex_approvals_on_request", "enforced"], ["config_only", "not_covered"]],
  [{ file: "~/.codex/config.toml", state: "read" }],
);
