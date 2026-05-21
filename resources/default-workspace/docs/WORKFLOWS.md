# Workflows

Common workspace workflows with step-by-step instructions.

## Set up OpenCode only

1. Open the **Settings tab**
2. Under Targets, enable only the OpenCode rule and config targets (disable Codex, Claude, Auggie)
3. Go to **Workspace tab**, run "Pull" only if the workspace is a Git checkout and you want `git pull --ff-only`
4. Run "Diff Rules" to preview rule sync
5. Run "Diff Configs" to preview config sync
6. Review diffs, then run "Sync Rules" and "Sync Configs" to apply

## Add a new skill

1. Create a directory under `skills/` with the skill slug (e.g., `skills/my-custom-skill/`)
2. Create `SKILL.md` inside the new directory
3. Write the skill instructions using the same pattern as existing skills
4. Save — the app detects new skills on the next refresh
5. Go to **Workspace tab**, open the SKILLS lane
6. Select your new skill, choose targets and scope, then dry-run
7. After reviewing the dry-run output, apply

## Edit global agent rules safely

1. Open the **Library tab**, select **Rules** from the source rail
2. Switch to edit mode, modify the rules, save
3. Go to **Workspace tab**, run "Diff Rules" to preview changes
4. Review which target files would be modified
5. If the diff looks correct, run "Sync Rules" to apply
6. Existing diverged target files are backed up before overwrite

## Version workspace changes with Git

1. Make workspace changes (edit docs, rules, config, or add skills)
2. Run a dry-run sync to verify changes work as expected
3. If this workspace includes `scripts/release-check.sh`, run release-check; otherwise use dry-run/diff plus Git review
4. Run `git status` to review changed files
5. Run `git diff` to inspect specific changes
6. Commit: `git commit -m "update: [describe change]"`
7. Push to share between machines: `git push`

See [GIT_VERSIONING.md](GIT_VERSIONING.md) for full Git setup and guidelines.

## Run release check when available

1. Ensure a valid workspace is active in the Workspace tab
2. Confirm the workspace includes `scripts/release-check.sh`
3. In the VERIFY lane, click "release-check"
4. Check the terminal output — all checks should pass
5. If checks fail, read the error messages and fix the indicated issue
6. Re-run release-check until all checks pass

The app repository release-check validates bundled default docs, scripts, starter metadata, forbidden source patterns, the frontend build, and Rust format/check/clippy/tests. It does not replace manual GUI smoke testing.

## Change enabled sync targets

1. Open the **Settings tab**
2. Apply a Settings target profile or toggle individual targets
3. Review the modified draft state
4. Click Save to persist the enabled target selection
5. Return to the Workspace tab and run diff before sync

Execution profiles are prompt metadata. Editing profiles does not change enabled sync targets.

## Debug a sync issue

1. In the **Workspace tab**, run "Pull" only if you need to update the workspace Git checkout
2. Check the system map for rule/config target states (valid, partial, dim)
3. Expand target nodes to see specific paths and issues
4. Run "Diff Rules" or "Diff Configs" to see what would change
5. Check `docs/TROUBLESHOOTING.md` for common issues
6. If release-check is available in this workspace, run it; otherwise inspect the dry-run/diff output and relevant docs
