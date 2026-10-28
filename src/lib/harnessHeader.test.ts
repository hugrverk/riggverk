import { describe, expect, it } from "vitest";
import type { AgentTargetMeta, ClaudeRuntimeHealth, CodexRuntimeHealth, LightRuntimeHealth, OpenCodeRuntimeHealth } from "../types";
import { harnessHomePath, harnessSubline } from "./harnessHeader";

function target(id: string, harness: AgentTargetMeta["harness"], rel: string): AgentTargetMeta {
  return { id, label: id, harness, kind: "rules", target_rel: rel, source_rel: "" };
}

const TARGETS: AgentTargetMeta[] = [
  target("claude_rules", "claude", ".claude/CLAUDE.md"),
  target("claude_agents", "claude", ".claude/agents"),
  target("claude_config", "claude", ".claude/settings.json"),
  target("opencode_rules", "opencode", ".config/opencode/AGENTS.md"),
  target("opencode_config", "opencode", ".config/opencode/opencode.json"),
  target("cursor_setup", "cursor", ".cursor/agents"),
];

describe("harnessHomePath", () => {
  it("is the folder every target of the harness shares", () => {
    expect(harnessHomePath(TARGETS, "claude")).toBe("~/.claude");
    expect(harnessHomePath(TARGETS, "opencode")).toBe("~/.config/opencode");
  });

  it("is the folder around a single target", () => {
    expect(harnessHomePath(TARGETS, "cursor")).toBe("~/.cursor");
  });

  it("is null when the backend listed no target for the harness", () => {
    expect(harnessHomePath(TARGETS, "pi")).toBeNull();
    expect(harnessHomePath([], "claude")).toBeNull();
  });
});

const CLAUDE = {
  harness: "claude" as const,
  health: { installed_agent_count: 5, claude_cli_available: true } as ClaudeRuntimeHealth,
};

describe("harnessSubline", () => {
  it("tells where it lives, how many skills it loads, how many agents it has and whether the CLI is there", () => {
    expect(harnessSubline({ home: "~/.claude", skills: 27, runtime: CLAUDE, dataFolderOk: true })).toBe(
      "~/.claude · 27 skills · 5 agents · CLI available",
    );
  });

  it("uses the singular and names a missing CLI", () => {
    const runtime = { harness: "claude" as const, health: { installed_agent_count: 1, claude_cli_available: false } as ClaudeRuntimeHealth };
    expect(harnessSubline({ home: "~/.claude", skills: 1, runtime, dataFolderOk: true })).toBe("~/.claude · 1 skill · 1 agent · CLI not found");
  });

  it("tells Codex's approval and sandbox, and leaves out what is not set", () => {
    const both = { harness: "codex" as const, health: { approval_policy: "on-request", sandbox_mode: "workspace-write" } as CodexRuntimeHealth };
    expect(harnessSubline({ home: "~/.codex", skills: null, runtime: both, dataFolderOk: true })).toBe(
      "~/.codex · approval on-request · sandbox workspace-write",
    );
    const none = { harness: "codex" as const, health: { approval_policy: null, sandbox_mode: null } as CodexRuntimeHealth };
    expect(harnessSubline({ home: "~/.codex", skills: null, runtime: none, dataFolderOk: true })).toBe("~/.codex");
  });

  it("tells the OpenCode CLI version", () => {
    const runtime = {
      harness: "opencode" as const,
      health: { cli: { status: "supported", version: "1.19.4", major: 1, detail: "" } } as OpenCodeRuntimeHealth,
    };
    expect(harnessSubline({ home: "~/.config/opencode", skills: 27, runtime, dataFolderOk: true })).toBe(
      "~/.config/opencode · 27 skills · CLI 1.19.4",
    );
  });

  it("tells the CLI of a light harness", () => {
    const found = { harness: "pi" as const, health: { cli: { status: "found", version: "1.3.0", source: "path", detail: "" } } as LightRuntimeHealth };
    expect(harnessSubline({ home: "~/.pi/agent", skills: null, runtime: found, dataFolderOk: true })).toBe("~/.pi/agent · CLI 1.3.0");
    const missing = { harness: "pi" as const, health: { cli: { status: "missing", version: null, source: null, detail: "" } } as LightRuntimeHealth };
    expect(harnessSubline({ home: "~/.pi/agent", skills: null, runtime: missing, dataFolderOk: true })).toBe("~/.pi/agent · CLI not found");
  });

  it("tells only the path while the runtime is not loaded, and without a usable workspace folder", () => {
    expect(harnessSubline({ home: "~/.claude", skills: null, runtime: { harness: "claude", health: null }, dataFolderOk: true })).toBe("~/.claude");
    expect(harnessSubline({ home: "~/.claude", skills: 27, runtime: CLAUDE, dataFolderOk: false })).toBe("~/.claude");
    expect(harnessSubline({ home: null, skills: null, runtime: { harness: "claude", health: null }, dataFolderOk: true })).toBe("");
  });
});
