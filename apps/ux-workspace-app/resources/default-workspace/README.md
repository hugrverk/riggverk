# Agent Workspace

Your workspace for managing agent skills, rules, configuration, and scripts.

This directory stores docs, skills, templates, config, and scripts that the app can read, display, and sync to agent tool folders. It is user-owned and can be versioned with git.

## What lives here

- **docs/** — documentation about workspace concepts, skills, rules, config, and troubleshooting
- **skills/** — user-installed agent skills (each skill in its own folder with a `SKILL.md`)
- **templates/** — source templates for agent rules and tool configuration
- **scripts/** — workspace sync and install scripts
- **.ux-workspace/** — workspace identity marker (do not delete)

## Separation

This workspace folder is separate from the app source code. The app operates on a workspace folder; the workspace does not need to contain the app.

## Start here

See [docs/START_HERE.md](docs/START_HERE.md) for a first-run guide.
