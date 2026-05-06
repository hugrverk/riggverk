# Agent Workspace v0.1.0-alpha

First public alpha for macOS.

Agent Workspace is a local macOS control panel for managing an agent workspace: docs, skills, global agent rules, OpenCode config, routing guidance, scripts, and safe sync workflows.

## Included

- Workspace creation from bundled starter resources
- Workspace diagnostics and contract validation
- Library browser/editor for docs, rules, skills, agents, and configs
- Diff/sync flows for agent rules and OpenCode config
- Skill install dry-run/apply workflows
- Routing guidance profiles
- Settings target profiles
- Backup visibility for apply operations
- Release-check support
- Bundled starter workspace with docs, scripts, agents, templates, routing profiles, and 22 starter skills

## Alpha notes

This is an unsigned and not notarized alpha build. macOS may show a Gatekeeper warning.

The app is local-first and filesystem-based. It does not create GitHub repos, manage GitHub auth, run agents, route tasks automatically, or sync anything on launch.

All write operations are explicit. Use dry-run/diff before apply.

## First run

1. Open the app.
2. Use the default workspace path or choose a folder.
3. Run dry-run create.
4. Create workspace if the dry-run says the target is safe.
5. Open Library > Start Here.
6. Use dry-run/diff before syncing rules/configs or installing skills.

## Security notes

Workspace files are plain text. Do not store or commit secrets, tokens, passwords, private keys, cookies, auth headers, signed/private URLs, or .env values.

## Known limitations

- macOS only.
- Unsigned and not notarized.
- Manual Git/GitHub setup only.
- No automatic import/upgrade flow for existing workspaces.
- No automatic routing or agent execution.
- Runtime smoke testing should be done manually using docs/APP_RELEASE_SMOKE.md.

## Build commit

15a22f35b39e14a1acae3845dfec4ee14a23d0fa
