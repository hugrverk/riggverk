# Start Here

## What this is

This is an agent workspace — a user-owned directory that stores docs, skills, templates, and scripts. An agent workspace app can read this directory, display its contents, and sync templates to agent tool folders on your system.

## Mental model

The app manages sync and display. The workspace is your data. The app reads your workspace; it does not overwrite your files without your action.

## What the app manages

- Displays workspace docs, templates, and skill catalog
- Syncs agent rules from `templates/global-agent-rules.md` to configured agent tool paths
- Syncs OpenCode config from `templates/opencode.json`
- Installs skills from `skills/` to agent tool skill folders
- Runs read-only release verification

## Safest first steps

1. Review `templates/global-agent-rules.md` — this defines agent behavior rules synced to your tools.
2. Review `templates/opencode.json` — this defines permission boundaries and tool configuration.
3. Add skills under `skills/` — each skill lives in its own folder with a `SKILL.md` file.
4. Run dry-run before sync — verify what would change without writing files.
5. Apply only after reviewing diffs.

## Dry-run before apply

Always prefer dry-run (preview/diff) before applying changes to your agent tool folders. This lets you review what would be written before writing anything.

## Workspace ownership

This workspace is yours. You can edit docs, add skills, modify templates, and version everything with git. The app does not hide or encrypt your workspace contents.
