# Agent Workspace

Agent Workspace is a local macOS app for managing agent workspaces: skills, global rules, tool config, workspace docs, health checks, and bundled starter resources.

The app includes a generic bundled default workspace at `apps/ux-workspace-app/resources/default-workspace/`. Settings can preview those resources, plan workspace creation for a safe empty or missing folder, and create a new workspace without overwriting existing files or running scripts.

## App Surfaces

- **Workspace**: operations cockpit (pull, diff/sync rules, diff/sync configs, skills install, release-check, backups), workspace creation, system map, diagnostics.
- **Library**: unified source browser and editor for Docs, Rules, Skills, Agents, and Configs.
- **Settings**: appearance, target profiles, enabled targets, workspace path.

## Local Development

```bash
cd apps/ux-workspace-app
npm install
npm run tauri dev
```

## Build

```bash
cd apps/ux-workspace-app
npm install
npm run build
npm run tauri build
```

## Release Check

Run from the repository root:

```bash
./scripts/release-check.sh
```

The check validates bundled default workspace scripts and metadata, scans app source for forbidden command patterns, runs the frontend build, and runs Rust formatting, check, clippy, and tests.

## License and notices

Agent Workspace is released under the [MIT License](LICENSE). Some bundled starter skills are adapted from third-party skill work; see [NOTICE.md](NOTICE.md).

## Transition Notes

The app source currently remains under `apps/ux-workspace-app/`. Internal package, crate, marker, settings, and bundle identifiers may still use `ux-workspace` names during the transition. Those identifiers are intentionally not renamed in this staging slice.

Private user workspace content is not included in this repository.
