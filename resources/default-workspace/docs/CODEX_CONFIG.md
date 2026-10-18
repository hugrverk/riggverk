# Codex Config

Versioned Codex config template with a managed-key merge.

The workspace supports Codex rules, native TOML agents, skills, and a managed config merge. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Files:

- `config.toml` is the canonical global template. Managed keys: `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `apps._default.approvals_reviewer`, `apps._default.default_tools_approval_mode`. Create-only keys: `model`, `model_reasoning_effort`. Codex 0.134+ removed the legacy top-level `profile = "..."` selector and `[profiles.*]` tables; profiles now live in separate `$CODEX_HOME/<name>.config.toml` overlays selected with `--profile`.
- `mcp/` contains optional MCP snippets. Review before use.

## What Install does

In the app, the config is the `codex_config` target on the Codex page. It is **off by default** because it sets your approval and sandbox posture. With it on, `u` previews and applies the merge into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).

- The five managed keys follow the template (currently `on-request`, reviewer `user`, `workspace-write`, prompt-based app tool approvals).
- `model` and `model_reasoning_effort` are written only when the file has no value for them (template: `gpt-6.1-sol`, `xhigh`). Afterwards they are yours: never overwritten, never reported as drift. Change the model in your own config.
- Personality, MCP entries, unrelated tables, comments (including same-line comments on managed keys), and unknown keys are preserved. Ambiguous TOML is refused with nothing written.
- App-shaped legacy `profile = "safe"` selectors and `[profiles.safe]` / `[profiles.workspace-write]` tables are removed during migration only, while they still hold app-shipped values. Other profiles are untouched.

The app installs from its bundled template, not from `templates/codex/config.toml` in your workspace. Python 3 must be on `PATH`.

## Agents, rules, skills

- Native agents: `templates/codex/agents/*.toml` install to `$CODEX_HOME/agents`.
- Rules: `$CODEX_HOME/AGENTS.md`, merge-managed ([AGENT_RULES.md](AGENT_RULES.md)). A non-empty `AGENTS.override.md` makes Codex ignore it.
- Skills: the app installs to `~/.agents/skills`, the folder Codex reads personal skills from (checked against Codex 0.163; Codex builds before about 0.100 do not read it, so update Codex if a skill does not show up; `$CODEX_HOME/skills` is still read but deprecated). With a customised `CODEX_HOME` or `CODEX_SKILLS_PATH` the skills go to `$CODEX_HOME/skills` instead, so Codex reads nothing outside its own home. Copies older versions put in `$CODEX_HOME/skills` (typically `~/.codex/skills`) are removed by the update with a backup; an edited copy stays and Codex lists that skill twice until you move or delete it. `$CODEX_HOME/skills/.system` is Codex's own and is never touched.
