# Git Versioning

The data folder (`~/.config/agent-workspace`) holds only the app's state and your personal docs, and holds no copy of the bundle: the bundle ships inside the app and changes with app updates. Version `docs/context/`, your own text, with Git like any other project. The app does not initialize repositories, create commits, create remotes, manage GitHub auth, push changes, or run `git pull` for you.

## Workflow

### Initial setup

```bash
# 1. Write a personal doc in the Library (Library tab, n); this creates docs/context/
# 2. Open a terminal in the data folder
cd ~/.config/agent-workspace

# 3. Initialize Git
git init

# 4. Keep the app's machine-local state out of Git
echo ".agent-workspace/" > .gitignore

# 5. Add your personal docs and make the initial commit
git add .gitignore docs/context
git commit -m "Initial personal docs"
```

### Connect to GitHub

Create a private GitHub repo manually (the app does not create repos), then:

```bash
git remote add origin git@github.com:your-username/your-private-repo.git
git branch -M main
git push -u origin main
```

## What to commit

Version only your own text:

- `docs/context/` — your personal docs

Keep `.agent-workspace/` out of Git. It describes this machine: `managed-state.json` records which files the app's installs own, `rules-preferences.json` which rules files you chose to leave as is, `kept-files.json` which skill and agent files you keep, and `workspace.json` is a marker an earlier release may have written. Do not delete the state files: a missing `managed-state.json` turns files that are not exact bundled copies into conflicts. On a new machine the first install creates them.

### Old copies from earlier releases

Earlier releases copied the bundle into this folder, and you may have committed it. After the reviewed cleanup (the `workspace` row, `u`, then `y`) the removals show in `git status` as deletions; commit them. Files the app left in place (edited, or not provably its own) stay yours to keep or delete. A copy you restore by hand that is byte-identical to a shipped version is planned for removal again on the next reviewed update.

## What not to commit

- **Secrets, tokens, passwords, private keys, cookies, auth headers, signed/private URLs** — never store credential-bearing data in workspace files
- **`.env` files** — keep environment variables out of the workspace
- **Machine-specific paths** — absolute paths that differ between machines
- **Backup directories** — app backups live outside the workspace
- **`.gitignore` should block** — `**/secrets*`, `.env*`, `credentials*`, `*.pem`, `*.key`

## Suggested .gitignore

```gitignore
# Machine-local app state
.agent-workspace/

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

- After writing or editing a personal doc
- Before the cleanup of old copies, if you versioned them, so the removals are their own commit
- Before sharing your docs between machines

## App and Git separation

The app reads your personal docs and displays their state. It does not:

- Run `git init`, `git add`, or `git commit`
- Create GitHub remotes or manage auth
- Push to remotes
- Run `git pull` or other Git commands for you
- Look at Git state in the workspace

Use your normal Git workflow (CLI, GitHub Desktop, IDE) to manage version history.

## Suggested workflow pattern

1. Write or edit personal docs in the Library
2. Run `git status` to review changes
3. Run `git diff` to inspect what changed
4. Commit with a descriptive message: `git commit -m "update: add release checklist notes"`
5. Push to share between machines: `git push`
