# Git Versioning

The workspace is a plain-text directory that can be versioned with Git like any other project. The app does not initialize repositories, create commits, create remotes, manage GitHub auth, push changes, or run `git pull` for you.

## Workflow

### Initial setup

```bash
# 1. Install the workspace with the app (Workspace tab, u, then y)
# 2. Open a terminal in the workspace directory
cd /path/to/your/workspace

# 3. Initialize Git
git init

# 4. Add all workspace files
git add .

# 5. Make the initial commit
git commit -m "Initial agent workspace"
```

### Connect to GitHub

Create a private GitHub repo manually (the app does not create repos), then:

```bash
git remote add origin git@github.com:your-username/your-private-repo.git
git branch -M main
git push -u origin main
```

## What to commit

Workspace files are designed to be versioned:

- `docs/` — workspace documentation
- `skills/` — agent skill definitions
- `templates/` — agent rules and config templates
- `agents/` — agent prompt definitions
- `scripts/` — CLI installers and helpers
- `metadata/` — generated manifests and rules history
- `.agent-workspace/workspace.json` — workspace marker (required for the folder to be valid)
- `README.md`

Keep `.agent-workspace/managed-state.json` and `.agent-workspace/rules-preferences.json` out of Git. They record which files this machine's installs the app owns and which rules files you chose to leave as is. Do not delete them: a missing `managed-state.json` turns files that are not exact bundled copies into conflicts. On a new machine the first install creates them.

## What not to commit

- **Secrets, tokens, passwords, private keys, cookies, auth headers, signed/private URLs** — never store credential-bearing data in workspace files
- **`.env` files** — keep environment variables out of the workspace
- **Machine-specific paths** — absolute paths that differ between machines
- **Backup directories** — app backups live outside the workspace
- **`.gitignore` should block** — `**/secrets*`, `.env*`, `credentials*`, `*.pem`, `*.key`

## Suggested .gitignore

```gitignore
# Machine-local app state
.agent-workspace/managed-state.json
.agent-workspace/rules-preferences.json

# Secrets and credentials
**/secrets*
.env
.env.*
credentials*
*.pem
*.key

# OS files
.DS_Store
Thumbs.db

# Editor files
*.swp
*.swo
*~
```

## When to commit

- After editing agent rules or config templates
- After adding or modifying skills
- After updating docs
- Before an install or update, so edited files can be compared (an edited bundled file becomes a conflict, see TROUBLESHOOTING)
- Before sharing workspace state between machines

## App and Git separation

The app reads workspace files and displays their state. It does not:

- Run `git init`, `git add`, or `git commit`
- Create GitHub remotes or manage auth
- Push to remotes
- Run `git pull` or other Git commands for you
- Look at Git state in the workspace

Use your normal Git workflow (CLI, GitHub Desktop, IDE) to manage version history.

## Suggested workflow pattern

1. Make workspace changes (edit docs, add skills, update templates)
2. Preview an install (`p`) to see what the app would change
3. Run `git status` to review changes
4. Run `git diff` to inspect what changed
5. Commit with a descriptive message: `git commit -m "update: add frontend design skill"`
6. Push to share between machines: `git push`
