# Git Versioning

The data folder (`~/.config/riggverk`) holds only the app's state and your personal docs. It holds no copy of the bundle: the bundle ships inside the app and changes with app updates. Version `docs/context/`, your own text, with Git like any other project.

The app never runs Git in this folder and never shows its Git state. It does not initialize repositories, create commits, create remotes, manage GitHub auth, or push or pull. Use your normal Git workflow (CLI, GitHub Desktop, IDE).

## Set up

```bash
# 1. Write a personal doc in the Library (Library tab, n); this creates docs/context/
# 2. Open a terminal in the data folder
cd ~/.config/riggverk

# 3. Initialize Git and keep the app's machine-local state out of it
git init
echo ".riggverk/" > .gitignore

# 4. Commit your personal docs
git add .gitignore docs/context
git commit -m "Initial personal docs"
```

To share them between machines, create a private repository on your Git host yourself, then:

```bash
git remote add origin git@github.com:your-username/your-private-repo.git
git branch -M main
git push -u origin main
```

## What to commit

Only your own text: `docs/context/`.

Keep `.riggverk/` out of Git. It describes this machine: `managed-state.json` records which files the app's installs own, `rules-preferences.json` which rules files you chose to leave as is, `kept-files.json` which skill and agent files you keep, `config-preferences.json` which managed Codex config keys you keep, and `workspace.json` is a marker an earlier release may have written. Do not delete the state files: a missing `managed-state.json` turns files that are not exact bundled copies into conflicts. On a new machine the first install creates them.

Never commit secrets, tokens, passwords, private keys, cookies, auth headers, signed or private URLs, `.env` files, or machine-specific absolute paths. App backups live outside this folder.

Suggested `.gitignore`:

```gitignore
# Machine-local app state
.riggverk/

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

## Old copies from earlier releases

Earlier releases copied the bundle into this folder, and you may have committed it. After the reviewed cleanup (the `workspace` row, `u`, then `y`) the removals show in `git status` as deletions; commit them on their own, ideally before you edit anything else. Files the app left in place (edited, or not provably its own) stay yours to keep or delete. A copy you restore by hand that is byte-identical to a shipped version is planned for removal again on the next reviewed update.

## When to commit

- After writing or editing a personal doc
- Before the cleanup of old copies, if you versioned them
- Before sharing your docs between machines
