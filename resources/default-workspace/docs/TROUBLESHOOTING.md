# Troubleshooting

## Workspace not installed or invalid

1. Open **Workspace** and check the installation status.
2. Run **Install or Update** and review the artifact preview.
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

Use **Install or Update**. Unknown or diverged unowned files are preserved and reported as conflicts.

## Dry-run before apply

```bash
./scripts/install-agent-rules.sh --diff
./scripts/install-opencode-config.sh --diff
./scripts/bootstrap.sh --diff
```

## Sync failures

- Confirm the workspace is valid (Workspace page shows INSTALLED).
- Enable the right targets on the harness page (changes autosave).
- Read terminal output on Workspace or the harness page for script errors.

## Installation rollback interrupted or stuck

1. Use rollback dry-run on the failed installation transaction.
2. Artifacts already restored are skipped; `in_flight` artifacts are reconciled against backup and post-apply state before retry.
3. If dry-run reports conflicts, resolve the listed config or file manually, then retry rollback.
4. When dry-run shows no remaining artifacts but status is still `rolling_back`, run rollback again to finalize without further file changes.
5. Codex inline comments on managed fields are preserved during merge; ambiguous lines refuse with zero mutation — fix the line manually if apply or rollback reports a safe-refusal error.

## Uninstall recovery unavailable after restart

**Recover previous uninstall** is session-scoped. If you uninstalled during the current session, use **preview recovery** and **restore workspace** before quitting the app. After restart, the recovery card is not shown automatically even when transaction backups remain on disk. Reinstall from **Install or Update** or restore files manually from the backup folder if needed.

## Release-check unavailable

The bundled starter may not include `scripts/release-check.sh`. Use the app source checkout workspace or copy the script if you need that check locally.
