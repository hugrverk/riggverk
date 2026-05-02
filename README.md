# Agent Workspace

Agent Workspace is a local macOS app for managing agent workspaces: skills, global rules, tool config, workspace docs, health checks, and bundled starter resources.

The app includes a generic bundled default workspace at `apps/ux-workspace-app/resources/default-workspace/`. Settings can preview those resources, plan workspace creation for a safe empty or missing folder, and create a new workspace without overwriting existing files or running scripts.

## App Surfaces

- Agents: rule target status, diff, and sync actions.
- Skills: bundled or workspace skill catalog and install dry-runs/actions.
- Configs: tool config template viewing, diff, and sync actions.
- Docs: workspace documentation browser.
- Health: release-check runner and workspace diagnostics.
- Settings: workspace path, target profiles, bundled defaults preview, and workspace creation.

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

## Transition Notes

The app source currently remains under `apps/ux-workspace-app/`. Internal package, crate, marker, settings, and bundle identifiers may still use `ux-workspace` names during the transition. Those identifiers are intentionally not renamed in this staging slice.

Private user workspace content is not included in this repository.
