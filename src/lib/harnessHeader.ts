import type { AgentTargetMeta, InstallAgent } from "../types";
import type { HarnessRuntimeHealth } from "./harnessRuntimeRows";
import { plural } from "./plural";

/**
 * The folder a harness keeps its files in, as people write it ("~/.claude", "~/.config/opencode"): the directory all
 * of the harness's targets share. Null when the backend listed no target for it.
 */
export function harnessHomePath(targets: readonly AgentTargetMeta[], harness: InstallAgent): string | null {
  const paths = targets.filter(target => target.harness === harness && target.target_rel).map(target => target.target_rel.split("/"));
  if (paths.length === 0) return null;
  let common = paths[0]!;
  for (const path of paths.slice(1)) {
    let shared = 0;
    while (shared < common.length && shared < path.length && common[shared] === path[shared]) shared += 1;
    common = common.slice(0, shared);
  }
  // One target is a file or a folder of its own: its home is the folder around it.
  if (paths.length === 1) common = common.slice(0, -1);
  return common.length > 0 ? `~/${common.join("/")}` : null;
}

/** What the runtime health says about a harness in a few words each: counts, CLI, approval and sandbox. */
function runtimeParts(runtime: HarnessRuntimeHealth): string[] {
  const health = runtime.health;
  if (!health) return [];
  switch (runtime.harness) {
    case "claude": {
      const claude = runtime.health!;
      return [plural(claude.installed_agent_count, "agent"), claude.claude_cli_available ? "CLI available" : "CLI not found"];
    }
    case "codex": {
      const codex = runtime.health!;
      return [
        ...(codex.approval_policy ? [`approval ${codex.approval_policy}`] : []),
        ...(codex.sandbox_mode ? [`sandbox ${codex.sandbox_mode}`] : []),
      ];
    }
    case "opencode": {
      const cli = runtime.health!.cli;
      return [
        ...(cli?.status === "missing" ? ["CLI not found"] : cli?.version ? [`CLI ${cli.version}`] : cli ? ["CLI found"] : []),
      ];
    }
    case "cursor":
      return [plural(runtime.health!.global_agents_count, "agent")];
    default: {
      const cli = runtime.health!.cli;
      return [cli.status === "missing" ? "CLI not found" : cli.version ? `CLI ${cli.version}` : "CLI found"];
    }
  }
}

/**
 * The mono line under a harness page's title: where it lives, how many skills it loads, and the few runtime facts
 * worth a glance. The page shows it in capitals (CSS); the text keeps the real case. Parts that are not known yet are
 * left out, and without a usable workspace folder only the path is told.
 */
export function harnessSubline(input: {
  home: string | null;
  skills: number | null;
  runtime: HarnessRuntimeHealth;
  dataFolderOk: boolean;
}): string {
  const parts = [
    ...(input.home ? [input.home] : []),
    ...(input.dataFolderOk ? [...(input.skills !== null ? [plural(input.skills, "skill")] : []), ...runtimeParts(input.runtime)] : []),
  ];
  return parts.join(" · ");
}
