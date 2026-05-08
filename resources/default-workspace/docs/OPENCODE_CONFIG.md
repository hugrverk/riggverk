# OpenCode Config

## Source template

The source template for OpenCode configuration is `templates/opencode.json`. This file defines:

- Share settings (recommended: disabled)
- Model selection via `model` and `small_model`
- Default primary agent via `default_agent`
- Permission model (which operations are allowed, denied, or require asking)
- File-scope read/edit deny rules for secrets and credentials
- Watcher ignore patterns

## OpenCode agents

OpenCode agent definitions live at `agents/*.md` in the workspace. Six bundled agents are provided:

- `agents/architect.md` — Default coding architect/orchestrator
- `agents/scout.md` — Repository structure explorer
- `agents/inspector.md` — Code inspection/review agent
- `agents/sentinel.md` — Security sentinel/audit review
- `agents/scribe.md` — Documentation writer
- `agents/verifier.md` — Non-destructive verification runner

`templates/opencode.json` defines global `model`, `small_model`, and `default_agent`. Canonical agent files may also pin explicit models when runtime behavior requires per-agent model selection. Current agents pin Pro for architect/inspector/sentinel and Flash for scout/scribe/verifier.

## Permission model

The default template is conservative:

- Sharing is disabled
- Most operations default to "ask"
- Read access is broadly allowed except for secret-bearing files (`.env`, keys, certificates, auth files)
- Write access is restricted to source code directories
- Destructive commands (`sudo`, `rm -rf`, pipe-to-bash) are denied

## Sync workflow

1. Review the template at `templates/opencode.json`
2. Run `--diff` to see differences between the template and your current config
3. Run `--apply` to write the template to `~/.config/opencode/opencode.json`

The sync also installs agent files to `~/.config/opencode/agents/*.md`. Extra existing runtime agent files in that directory are not deleted.

A backup is created before overwriting if the current config or agent files differ.

## Customization

The template is user-editable. Add project-specific allow/deny rules as needed. Avoid weakening the secret-file deny rules in the `read` and `edit` sections.

Agent files are also user-editable. Customize agent behavior by editing `agents/*.md` files in the workspace.
