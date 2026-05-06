# Start Here

## What this is

This is an agent workspace — a user-owned directory that stores docs, skills, templates, and scripts. The Agent Workspace app reads this directory, displays its contents, and syncs templates to agent tool folders on your system.

## What the app is and is not

The app is a desktop sync tool for managing agent configuration across tools like OpenCode, Codex, Claude, Gemini, and Auggie. It helps you:

- Browse and edit workspace docs, skills, templates, and rules
- Preview sync operations (dry-run/diff) before writing files
- Sync agent rules and config to tool folders
- Install skills to agent tool directories
- Run release verification checks on the workspace

The app does not:

- Write files automatically on launch — all writes are explicit
- Manage GitHub authentication or create remote repos automatically
- Encrypt workspace contents — the workspace is plain text owned by you
- Auto-create workspace directories — you confirm the path first
- Import or upgrade existing non-workspace directories

## Mental model

- **The app** manages sync and display operations.
- **The workspace** is your data — a directory of plain-text files you own and version.
- The app reads your workspace but never overwrites anything without your explicit action.

## Safe first steps (first 5 minutes)

1. **Inspect the default workspace** — the app shows a "Bundled Starter" preview in the Workspace tab.
2. **Create a workspace** — choose a folder or use the default path, then dry-run and create.
3. **Open the Library tab** — browse this doc, Concepts, and guides grouped under Start, Guides, and Reference.
4. **Read CONCEPTS.md** — understand workspace terms before editing.
5. **Review templates** — look at `templates/global-agent-rules.md` and `templates/opencode.json`.

## What to click in the app

- **Workspace tab**: View diagnostics, create workspace, sync rules/configs, install skills, verify workspace.
- **Library tab**: Read and edit docs, rules, skills, agents, and config templates.
- **Routing tab**: Manage sync routing profiles for different setups.
- **Settings tab**: Configure appearance and target tool settings.

## Dry-run before apply

Always dry-run (preview/diff) before applying changes. The app shows what would be written without touching files. Scripts follow the same pattern: `--dry-run`, `--diff`, then `--apply`.

## Workspace ownership

This workspace is yours. Edit docs, add skills, modify templates, version with Git. The app does not hide, encrypt, or lock your workspace contents.

## Next steps

- Read [CONCEPTS.md](CONCEPTS.md) for core terms
- Read [USING_THE_APP.md](USING_THE_APP.md) for a practical walkthrough
- Read [GIT_VERSIONING.md](GIT_VERSIONING.md) to version the workspace
- Run a dry-run sync to preview what would change
