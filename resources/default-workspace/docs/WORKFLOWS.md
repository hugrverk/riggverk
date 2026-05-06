# Workflows

Common workspace workflows with step-by-step instructions.

## Set up OpenCode only

1. Open the **Settings tab**
2. Under Targets, enable only the OpenCode rule and config targets (disable Codex, Claude, Gemini, Auggie)
3. Go to **Workspace tab**, run "Pull" to refresh status
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
3. Run release-check to validate workspace integrity
4. Run `git status` to review changed files
5. Run `git diff` to inspect specific changes
6. Commit: `git commit -m "update: [describe change]"`
7. Push to share between machines: `git push`

See [GIT_VERSIONING.md](GIT_VERSIONING.md) for full Git setup and guidelines.

## Run release check before sharing or syncing

1. Ensure valid workspace is active in the Workspace tab
2. In the VERIFY lane, click "release-check"
3. Check the terminal output — all checks should pass
4. If checks fail, read the error messages and fix the indicated issue
5. Re-run release-check until all checks pass

The release check validates:
- All required workspace files are present
- Scripts have valid syntax and no placeholder phrases
- Agent definitions are non-empty with correct modes
- No private names or secrets in the bundle
- Skill count and baseline skills are intact

## Change sync target profiles

1. Open the **Routing tab**
2. Create or select a profile with the desired target configuration
3. Go to **Settings tab**, under Profiles, apply the profile
4. Targets update immediately — the Workspace tab status reflects the new enabled targets

## Debug a sync issue

1. In the **Workspace tab**, run "Pull" to get the latest status
2. Check the system map for rule/config target states (valid, partial, dim)
3. Expand target nodes to see specific paths and issues
4. Run "Diff Rules" or "Diff Configs" to see what would change
5. Check `docs/TROUBLESHOOTING.md` for common issues
6. Run release-check to validate workspace integrity
