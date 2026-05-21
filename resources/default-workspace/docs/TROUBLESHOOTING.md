# Troubleshooting

## Workspace not installed or invalid

1. Open **Workspace** and check the status chip (MISSING / NEEDS REPAIR / INSTALLED).
2. Click **install** if missing, or **repair** if markers are incomplete.
3. Confirm `.agent-workspace/workspace.json` exists under `~/.config/agent-workspace`.
4. For dev/test, `AGENT_WORKSPACE_PATH` can point at another valid workspace root.

## Missing markers

| Marker | Kind |
|--------|------|
| `.agent-workspace/workspace.json` | file |
| `scripts/bootstrap.sh` | file |
| `scripts/install-skills.sh` | file |
| `scripts/install-agent-rules.sh` | file |
| `scripts/install-opencode-config.sh` | file |
| `templates/global-agent-rules.md` | file |
| `templates/opencode.json` | file |
| `README.md` | file |
| `skills/` | directory |

Use **repair** to copy only missing bundled files without overwriting your edits.

## Dry-run before apply

```bash
./scripts/install-agent-rules.sh --diff
./scripts/install-opencode-config.sh --diff
./scripts/bootstrap.sh --diff
```

## Sync failures

- Confirm the workspace is valid (Workspace page shows INSTALLED).
- Enable the right targets on the harness page or in Settings, then Save.
- Read terminal output on Workspace or the harness page for script errors.

## Release-check unavailable

The bundled starter may not include `scripts/release-check.sh`. Use the app source checkout workspace or copy the script if you need that check locally.
