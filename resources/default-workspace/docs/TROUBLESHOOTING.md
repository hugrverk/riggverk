# Troubleshooting

## Invalid workspace path

The app validates the workspace path before any operations. If the workspace is reported as invalid:

1. Verify `.ux-workspace/workspace.json` exists in the workspace root
2. Verify all required markers are present: scripts, templates, README, and skills directory
3. Check that the workspace path in settings points to a valid directory
4. Verify file permissions allow reading the workspace directory

## Missing markers

The workspace requires these markers:

| Marker | Kind |
|--------|------|
| `.ux-workspace/workspace.json` | file |
| `scripts/bootstrap.sh` | file |
| `scripts/install-skills.sh` | file |
| `scripts/install-agent-rules.sh` | file |
| `scripts/install-opencode-config.sh` | file |
| `templates/global-agent-rules.md` | file |
| `templates/opencode.json` | file |
| `README.md` | file |
| `skills/` | directory |

A missing marker will cause workspace validation to fail.

## Dry-run before apply

If you are unsure about changes, use dry-run or diff mode to preview before applying:

```bash
./scripts/install-agent-rules.sh --diff
./scripts/install-opencode-config.sh --diff
./scripts/bootstrap.sh --diff
```

These modes show what would change without writing files.

## Missing tool folders

If sync reports a missing target, the destination tool folder may not exist. Create the tool's config directory manually or install the agent tool first.

## Permissions

If scripts fail to read or write files:

1. Check that the workspace directory and its contents are readable
2. Check that target agent tool directories are writable
3. Run with `--diff` to verify template content is readable without writing

## Inspecting scripts

All workspace scripts support `--help`. Run any script with `--help` to see available options and modes.

Use `--quiet` for compact output suitable for app display. Omit `--quiet` for verbose output when debugging in a terminal.
