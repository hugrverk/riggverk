---
name: architect
description: Default autonomous implementation architect/orchestrator. Use for most user tasks. Break work into bounded slices, inspect repository reality first, delegate investigation/review/docs/security/QA work to subagents when useful, implement safe patches, verify, commit only when the user requested it, and report exact changes.
mode: primary
temperature: 0.2
steps: 100
permission:
  "*": ask
  external_directory:
    "*": ask
    "~/.claude/skills/*": allow
    "~/.agents/skills/*": allow
    "~/.config/opencode/skills/*": allow
  doom_loop: ask
  todowrite: allow
  read:
    "*": allow
    ".env*": deny
    "*.env*": deny
    "**/.env*": deny
    "*.key": deny
    "**/*.key": deny
    "*.pem": deny
    "**/*.pem": deny
    "*.p12": deny
    "**/*.p12": deny
    "*.pfx": deny
    "**/*.pfx": deny
    "secrets/**": deny
    "**/secrets/**": deny
    ".ssh/**": deny
    "**/.ssh/**": deny
    ".gnupg/**": deny
    "**/.gnupg/**": deny
    "auth.json": deny
    "**/auth.json": deny
    "service-account*.json": deny
    "**/service-account*.json": deny
    "*service-account*.json": deny
    "**/*service-account*.json": deny
    "credentials*.json": deny
    "**/credentials*.json": deny
    "*credentials*.json": deny
    "**/*credentials*.json": deny
    "*token*.json": deny
    "**/*token*.json": deny
    "*secret*.json": deny
    "**/*secret*.json": deny
    "firebase-adminsdk*.json": deny
    "**/firebase-adminsdk*.json": deny
    "google-credentials*.json": deny
    "**/google-credentials*.json": deny
    "wp-config.php": deny
    "**/wp-config.php": deny
    ".npmrc": deny
    "**/.npmrc": deny
    ".netrc": deny
    "**/.netrc": deny
    ".pypirc": deny
    "**/.pypirc": deny
    ".aws/**": deny
    "**/.aws/**": deny
    ".config/gh/**": deny
    "**/.config/gh/**": deny
    ".docker/config.json": deny
    "**/.docker/config.json": deny
    "id_rsa": deny
    "**/id_rsa": deny
    "id_ed25519": deny
    "**/id_ed25519": deny
    "id_ecdsa": deny
    "**/id_ecdsa": deny
    "id_dsa": deny
    "**/id_dsa": deny
    "kubeconfig": deny
    "**/kubeconfig": deny
    ".kube/**": deny
    "**/.kube/**": deny
    "terraform.tfvars": deny
    "**/terraform.tfvars": deny
    "*.tfvars": deny
    "**/*.tfvars": deny
    "terraform.tfstate*": deny
    "**/terraform.tfstate*": deny
    "vault.yml": deny
    "**/vault.yml": deny
    "secrets.yml": deny
    "**/secrets.yml": deny
    "master.key": deny
    "**/master.key": deny
    ".pgpass": deny
    "**/.pgpass": deny
    ".my.cnf": deny
    "**/.my.cnf": deny
    ".envrc": deny
    "**/.envrc": deny
    ".bash_history": deny
    "**/.bash_history": deny
    ".zsh_history": deny
    "**/.zsh_history": deny
    "*.ppk": deny
    "**/*.ppk": deny
    "*.jks": deny
    "**/*.jks": deny
    "Pulumi.*.yaml": deny
    "**/Pulumi.*.yaml": deny
    "mcp.json": deny
    "**/mcp.json": deny
    ".claude.json": deny
    "**/.claude.json": deny
    ".codex/config.toml": deny
    "**/.codex/config.toml": deny
    ".git-credentials": deny
    "**/.git-credentials": deny
    ".git/config": deny
    "**/.git/config": deny
    ".env.example": allow
    "**/.env.example": allow
    ".env.sample": allow
    "**/.env.sample": allow
    ".env.template": allow
    "**/.env.template": allow
    "example.env": allow
    "**/example.env": allow
  glob: allow
  grep: allow
  list: allow
  lsp: allow
  question: allow
  webfetch: ask
  websearch: ask
  task:
    "*": deny
    "explore": allow
    "repo-scout": allow
    "inspector": allow
    "sentinel": allow
    "scribe": allow
    "verifier": allow
  skill:
    "*": allow
  bash:
    "*": ask
    "pwd": allow
    "ls *": allow
    "tree": allow
    "tree -a": allow
    "tree -d": allow
    "tree -L ?": allow
    "tree -a -L ?": allow
    "tree -d -L ?": allow
    "git status*": allow
    "git diff": allow
    "git diff --stat": allow
    "git diff --cached": allow
    "git diff --staged": allow
    "git diff --name-only": allow
    "git diff --name-status": allow
    "git diff --cached --stat": allow
    "git diff --cached --name-only": allow
    "git diff HEAD": allow
    "git diff HEAD --stat": allow
    "git diff HEAD~?": allow
    "git diff HEAD~? --stat": allow
    "git log": allow
    "git log -?": allow
    "git log -??": allow
    "git log --oneline": allow
    "git log --oneline -?": allow
    "git log --oneline -??": allow
    "git log --oneline --decorate": allow
    "git log --oneline --graph": allow
    "git log --oneline --graph -??": allow
    "git log --stat -?": allow
    "git show": allow
    "git show HEAD": allow
    "git show HEAD~?": allow
    "git show --stat": allow
    "git show --stat HEAD": allow
    "git show --stat HEAD~?": allow
    "git show --name-only HEAD": allow
    "git show --name-status HEAD": allow
    "git branch": allow
    "git branch --list*": allow
    "git branch --show-current": allow
    "git branch -a": allow
    "git branch -r": allow
    "git branch -v": allow
    "git branch -vv": allow
    "git rev-parse*": allow
    "git ls-files*": allow
    "git add *": allow
    "git commit *": allow
    "git fetch": allow
    "git fetch origin": allow
    "git fetch upstream": allow
    "mkdir *": allow
    "mkdir -p *": allow
    "touch *": allow
    "npm test": allow
    "npm test -- *": allow
    "npm run test": allow
    "npm run test -- *": allow
    "npm run lint": allow
    "npm run lint -- *": allow
    "npm run typecheck": allow
    "npm run typecheck -- *": allow
    "npm run build": allow
    "npm run build -- *": allow
    "npm run verify": allow
    "npm run verify -- *": allow
    "pnpm test": allow
    "pnpm test -- *": allow
    "pnpm run test": allow
    "pnpm run test -- *": allow
    "pnpm run lint": allow
    "pnpm run lint -- *": allow
    "pnpm run typecheck": allow
    "pnpm run typecheck -- *": allow
    "pnpm run build": allow
    "pnpm run build -- *": allow
    "pnpm run verify": allow
    "pnpm run verify -- *": allow
    "yarn test": allow
    "yarn test -- *": allow
    "yarn run test": allow
    "yarn run test -- *": allow
    "yarn run lint": allow
    "yarn run lint -- *": allow
    "yarn run typecheck": allow
    "yarn run typecheck -- *": allow
    "yarn run build": allow
    "yarn run build -- *": allow
    "yarn run verify": allow
    "yarn run verify -- *": allow
    "bun test": allow
    "bun run test": allow
    "bun run lint": allow
    "bun run typecheck": allow
    "bun run build": allow
    "bun run verify": allow
    "cargo fmt": allow
    "cargo fmt --check": allow
    "cargo fmt --all": allow
    "cargo fmt --all --check": allow
    "cargo fmt --all -- --check": allow
    "cargo check": allow
    "cargo check --workspace": allow
    "cargo check --all-targets": allow
    "cargo check --workspace --all-targets": allow
    "cargo clippy": allow
    "cargo clippy --workspace": allow
    "cargo clippy --all-targets": allow
    "cargo clippy --workspace --all-targets": allow
    "cargo clippy -- -D warnings": allow
    "cargo clippy --all-targets -- -D warnings": allow
    "cargo clippy --workspace --all-targets -- -D warnings": allow
    "cargo test": allow
    "cargo test -- *": allow
    "cargo test --workspace": allow
    "cargo test --workspace -- *": allow
    "cargo test --lib": allow
    "cargo test --lib -- *": allow
    "cargo test --all-targets": allow
    "pytest": allow
    "pytest -q": allow
    "python3 -m pytest": allow
    "python3 -m pytest -q": allow
    "go test ./...": allow
    "go vet ./...": allow
    "make test": allow
    "make lint": allow
    "make check": allow
    "grep *": ask
    "rg *": ask
    "git grep*": ask
    "git push*": ask
    "git checkout*": ask
    "git switch*": ask
    "git restore*": ask
    "git reset*": ask
    "git clean*": ask
    "git pull*": ask
    "git merge*": ask
    "git rebase*": ask
    "git stash*": ask
    "git tag*": ask
    "cp *": ask
    "mv *": ask
    "npm run dev*": ask
    "npm run start*": ask
    "npm run deploy*": ask
    "npm run db*": ask
    "npm run migrate*": ask
    "npm run migration*": ask
    "npm run seed*": ask
    "npm run reset*": ask
    "pnpm dev*": ask
    "pnpm start*": ask
    "pnpm deploy*": ask
    "pnpm db*": ask
    "pnpm migrate*": ask
    "pnpm migration*": ask
    "pnpm seed*": ask
    "pnpm reset*": ask
    "bun dev*": ask
    "bun start*": ask
    "bun deploy*": ask
    "bun db*": ask
    "bun migrate*": ask
    "bun migration*": ask
    "bun seed*": ask
    "bun reset*": ask
    "yarn dev*": ask
    "yarn start*": ask
    "yarn deploy*": ask
    "yarn db*": ask
    "yarn migrate*": ask
    "yarn migration*": ask
    "yarn seed*": ask
    "yarn reset*": ask
    "npm install*": ask
    "npm update*": ask
    "npm audit fix*": ask
    "npx *": ask
    "pnpm install*": ask
    "pnpm add*": ask
    "pnpm update*": ask
    "bun install*": ask
    "bun add*": ask
    "yarn install*": ask
    "yarn add*": ask
    "yarn upgrade*": ask
    "curl*": ask
    "wget*": ask
    "rm *": ask
    "rm -r*": ask
    "*>*": ask
    "*>>*": ask
    "rg *--hidden*": ask
    "cat *": ask
    "head *": ask
    "tail *": ask
    "sed *": ask
    "git grep *": ask
    "git commit*--amend*": ask
    "git push --force*": deny
    "git push -f*": deny
    "git reset --hard*": deny
    "git clean -fd*": deny
    "git clean -fdx*": deny
    "rm -rf*": deny
    "rm -fr*": deny
    "sudo*": deny
    "bash": deny
    "sh": deny
    "zsh": deny
    "bash -": deny
    "sh -": deny
    "zsh -": deny
    "bash -s*": deny
    "sh -s*": deny
    "zsh -s*": deny
    "cat .env*": deny
    "cat * .env*": deny
    "cat */.env*": deny
    "cat *.key": deny
    "cat *.key *": deny
    "cat *.pem": deny
    "cat *.pem *": deny
    "cat *.p12": deny
    "cat *.p12 *": deny
    "cat *.pfx": deny
    "cat *.pfx *": deny
    "cat secrets/**": deny
    "cat * secrets/**": deny
    "cat */secrets/**": deny
    "cat .ssh/**": deny
    "cat * .ssh/**": deny
    "cat */.ssh/**": deny
    "cat .gnupg/**": deny
    "cat * .gnupg/**": deny
    "cat */.gnupg/**": deny
    "cat auth.json": deny
    "cat auth.json *": deny
    "cat * auth.json *": deny
    "cat */auth.json *": deny
    "cat service-account*.json": deny
    "cat service-account*.json *": deny
    "cat * service-account*.json *": deny
    "cat */service-account*.json *": deny
    "cat *service-account*.json": deny
    "cat *service-account*.json *": deny
    "cat credentials*.json": deny
    "cat credentials*.json *": deny
    "cat * credentials*.json *": deny
    "cat */credentials*.json *": deny
    "cat *credentials*.json": deny
    "cat *credentials*.json *": deny
    "cat *token*.json": deny
    "cat *token*.json *": deny
    "cat *secret*.json": deny
    "cat *secret*.json *": deny
    "cat firebase-adminsdk*.json": deny
    "cat firebase-adminsdk*.json *": deny
    "cat * firebase-adminsdk*.json *": deny
    "cat */firebase-adminsdk*.json *": deny
    "cat google-credentials*.json": deny
    "cat google-credentials*.json *": deny
    "cat * google-credentials*.json *": deny
    "cat */google-credentials*.json *": deny
    "cat wp-config.php": deny
    "cat wp-config.php *": deny
    "cat * wp-config.php *": deny
    "cat */wp-config.php *": deny
    "cat .npmrc": deny
    "cat .npmrc *": deny
    "cat * .npmrc *": deny
    "cat */.npmrc *": deny
    "cat .netrc": deny
    "cat .netrc *": deny
    "cat * .netrc *": deny
    "cat */.netrc *": deny
    "cat .pypirc": deny
    "cat .pypirc *": deny
    "cat * .pypirc *": deny
    "cat */.pypirc *": deny
    "cat .aws/**": deny
    "cat * .aws/**": deny
    "cat */.aws/**": deny
    "cat .config/gh/**": deny
    "cat * .config/gh/**": deny
    "cat */.config/gh/**": deny
    "cat .docker/config.json": deny
    "cat .docker/config.json *": deny
    "cat * .docker/config.json *": deny
    "cat */.docker/config.json *": deny
    "cat id_rsa": deny
    "cat id_rsa *": deny
    "cat * id_rsa *": deny
    "cat */id_rsa *": deny
    "cat id_ed25519": deny
    "cat id_ed25519 *": deny
    "cat * id_ed25519 *": deny
    "cat */id_ed25519 *": deny
    "cat id_ecdsa": deny
    "cat id_ecdsa *": deny
    "cat * id_ecdsa *": deny
    "cat */id_ecdsa *": deny
    "cat id_dsa": deny
    "cat id_dsa *": deny
    "cat * id_dsa *": deny
    "cat */id_dsa *": deny
    "cat kubeconfig": deny
    "cat kubeconfig *": deny
    "cat * kubeconfig *": deny
    "cat */kubeconfig *": deny
    "cat .kube/**": deny
    "cat * .kube/**": deny
    "cat */.kube/**": deny
    "cat terraform.tfvars": deny
    "cat terraform.tfvars *": deny
    "cat * terraform.tfvars *": deny
    "cat */terraform.tfvars *": deny
    "cat *.tfvars": deny
    "cat *.tfvars *": deny
    "cat terraform.tfstate*": deny
    "cat * terraform.tfstate*": deny
    "cat */terraform.tfstate*": deny
    "cat vault.yml": deny
    "cat vault.yml *": deny
    "cat * vault.yml *": deny
    "cat */vault.yml *": deny
    "cat secrets.yml": deny
    "cat secrets.yml *": deny
    "cat * secrets.yml *": deny
    "cat */secrets.yml *": deny
    "cat master.key": deny
    "cat master.key *": deny
    "cat * master.key *": deny
    "cat */master.key *": deny
    "cat .pgpass": deny
    "cat .pgpass *": deny
    "cat * .pgpass *": deny
    "cat */.pgpass *": deny
    "cat .my.cnf": deny
    "cat .my.cnf *": deny
    "cat * .my.cnf *": deny
    "cat */.my.cnf *": deny
    "cat .envrc": deny
    "cat .envrc *": deny
    "cat * .envrc *": deny
    "cat */.envrc *": deny
    "cat .bash_history": deny
    "cat .bash_history *": deny
    "cat * .bash_history *": deny
    "cat */.bash_history *": deny
    "cat .zsh_history": deny
    "cat .zsh_history *": deny
    "cat * .zsh_history *": deny
    "cat */.zsh_history *": deny
    "cat *.ppk": deny
    "cat *.ppk *": deny
    "cat *.jks": deny
    "cat *.jks *": deny
    "cat Pulumi.*.yaml": deny
    "cat Pulumi.*.yaml *": deny
    "cat * Pulumi.*.yaml *": deny
    "cat */Pulumi.*.yaml *": deny
    "cat mcp.json": deny
    "cat mcp.json *": deny
    "cat * mcp.json *": deny
    "cat */mcp.json *": deny
    "cat .claude.json": deny
    "cat .claude.json *": deny
    "cat * .claude.json *": deny
    "cat */.claude.json *": deny
    "cat .codex/config.toml": deny
    "cat .codex/config.toml *": deny
    "cat * .codex/config.toml *": deny
    "cat */.codex/config.toml *": deny
    "cat .git-credentials": deny
    "cat .git-credentials *": deny
    "cat * .git-credentials *": deny
    "cat */.git-credentials *": deny
    "cat .git/config": deny
    "cat .git/config *": deny
    "cat * .git/config *": deny
    "cat */.git/config *": deny
    "head .env*": deny
    "head * .env*": deny
    "head */.env*": deny
    "head *.key": deny
    "head *.key *": deny
    "head *.pem": deny
    "head *.pem *": deny
    "head *.p12": deny
    "head *.p12 *": deny
    "head *.pfx": deny
    "head *.pfx *": deny
    "head secrets/**": deny
    "head * secrets/**": deny
    "head */secrets/**": deny
    "head .ssh/**": deny
    "head * .ssh/**": deny
    "head */.ssh/**": deny
    "head .gnupg/**": deny
    "head * .gnupg/**": deny
    "head */.gnupg/**": deny
    "head auth.json": deny
    "head auth.json *": deny
    "head * auth.json *": deny
    "head */auth.json *": deny
    "head service-account*.json": deny
    "head service-account*.json *": deny
    "head * service-account*.json *": deny
    "head */service-account*.json *": deny
    "head *service-account*.json": deny
    "head *service-account*.json *": deny
    "head credentials*.json": deny
    "head credentials*.json *": deny
    "head * credentials*.json *": deny
    "head */credentials*.json *": deny
    "head *credentials*.json": deny
    "head *credentials*.json *": deny
    "head *token*.json": deny
    "head *token*.json *": deny
    "head *secret*.json": deny
    "head *secret*.json *": deny
    "head firebase-adminsdk*.json": deny
    "head firebase-adminsdk*.json *": deny
    "head * firebase-adminsdk*.json *": deny
    "head */firebase-adminsdk*.json *": deny
    "head google-credentials*.json": deny
    "head google-credentials*.json *": deny
    "head * google-credentials*.json *": deny
    "head */google-credentials*.json *": deny
    "head wp-config.php": deny
    "head wp-config.php *": deny
    "head * wp-config.php *": deny
    "head */wp-config.php *": deny
    "head .npmrc": deny
    "head .npmrc *": deny
    "head * .npmrc *": deny
    "head */.npmrc *": deny
    "head .netrc": deny
    "head .netrc *": deny
    "head * .netrc *": deny
    "head */.netrc *": deny
    "head .pypirc": deny
    "head .pypirc *": deny
    "head * .pypirc *": deny
    "head */.pypirc *": deny
    "head .aws/**": deny
    "head * .aws/**": deny
    "head */.aws/**": deny
    "head .config/gh/**": deny
    "head * .config/gh/**": deny
    "head */.config/gh/**": deny
    "head .docker/config.json": deny
    "head .docker/config.json *": deny
    "head * .docker/config.json *": deny
    "head */.docker/config.json *": deny
    "head id_rsa": deny
    "head id_rsa *": deny
    "head * id_rsa *": deny
    "head */id_rsa *": deny
    "head id_ed25519": deny
    "head id_ed25519 *": deny
    "head * id_ed25519 *": deny
    "head */id_ed25519 *": deny
    "head id_ecdsa": deny
    "head id_ecdsa *": deny
    "head * id_ecdsa *": deny
    "head */id_ecdsa *": deny
    "head id_dsa": deny
    "head id_dsa *": deny
    "head * id_dsa *": deny
    "head */id_dsa *": deny
    "head kubeconfig": deny
    "head kubeconfig *": deny
    "head * kubeconfig *": deny
    "head */kubeconfig *": deny
    "head .kube/**": deny
    "head * .kube/**": deny
    "head */.kube/**": deny
    "head terraform.tfvars": deny
    "head terraform.tfvars *": deny
    "head * terraform.tfvars *": deny
    "head */terraform.tfvars *": deny
    "head *.tfvars": deny
    "head *.tfvars *": deny
    "head terraform.tfstate*": deny
    "head * terraform.tfstate*": deny
    "head */terraform.tfstate*": deny
    "head vault.yml": deny
    "head vault.yml *": deny
    "head * vault.yml *": deny
    "head */vault.yml *": deny
    "head secrets.yml": deny
    "head secrets.yml *": deny
    "head * secrets.yml *": deny
    "head */secrets.yml *": deny
    "head master.key": deny
    "head master.key *": deny
    "head * master.key *": deny
    "head */master.key *": deny
    "head .pgpass": deny
    "head .pgpass *": deny
    "head * .pgpass *": deny
    "head */.pgpass *": deny
    "head .my.cnf": deny
    "head .my.cnf *": deny
    "head * .my.cnf *": deny
    "head */.my.cnf *": deny
    "head .envrc": deny
    "head .envrc *": deny
    "head * .envrc *": deny
    "head */.envrc *": deny
    "head .bash_history": deny
    "head .bash_history *": deny
    "head * .bash_history *": deny
    "head */.bash_history *": deny
    "head .zsh_history": deny
    "head .zsh_history *": deny
    "head * .zsh_history *": deny
    "head */.zsh_history *": deny
    "head *.ppk": deny
    "head *.ppk *": deny
    "head *.jks": deny
    "head *.jks *": deny
    "head Pulumi.*.yaml": deny
    "head Pulumi.*.yaml *": deny
    "head * Pulumi.*.yaml *": deny
    "head */Pulumi.*.yaml *": deny
    "head mcp.json": deny
    "head mcp.json *": deny
    "head * mcp.json *": deny
    "head */mcp.json *": deny
    "head .claude.json": deny
    "head .claude.json *": deny
    "head * .claude.json *": deny
    "head */.claude.json *": deny
    "head .codex/config.toml": deny
    "head .codex/config.toml *": deny
    "head * .codex/config.toml *": deny
    "head */.codex/config.toml *": deny
    "head .git-credentials": deny
    "head .git-credentials *": deny
    "head * .git-credentials *": deny
    "head */.git-credentials *": deny
    "head .git/config": deny
    "head .git/config *": deny
    "head * .git/config *": deny
    "head */.git/config *": deny
    "tail .env*": deny
    "tail * .env*": deny
    "tail */.env*": deny
    "tail *.key": deny
    "tail *.key *": deny
    "tail *.pem": deny
    "tail *.pem *": deny
    "tail *.p12": deny
    "tail *.p12 *": deny
    "tail *.pfx": deny
    "tail *.pfx *": deny
    "tail secrets/**": deny
    "tail * secrets/**": deny
    "tail */secrets/**": deny
    "tail .ssh/**": deny
    "tail * .ssh/**": deny
    "tail */.ssh/**": deny
    "tail .gnupg/**": deny
    "tail * .gnupg/**": deny
    "tail */.gnupg/**": deny
    "tail auth.json": deny
    "tail auth.json *": deny
    "tail * auth.json *": deny
    "tail */auth.json *": deny
    "tail service-account*.json": deny
    "tail service-account*.json *": deny
    "tail * service-account*.json *": deny
    "tail */service-account*.json *": deny
    "tail *service-account*.json": deny
    "tail *service-account*.json *": deny
    "tail credentials*.json": deny
    "tail credentials*.json *": deny
    "tail * credentials*.json *": deny
    "tail */credentials*.json *": deny
    "tail *credentials*.json": deny
    "tail *credentials*.json *": deny
    "tail *token*.json": deny
    "tail *token*.json *": deny
    "tail *secret*.json": deny
    "tail *secret*.json *": deny
    "tail firebase-adminsdk*.json": deny
    "tail firebase-adminsdk*.json *": deny
    "tail * firebase-adminsdk*.json *": deny
    "tail */firebase-adminsdk*.json *": deny
    "tail google-credentials*.json": deny
    "tail google-credentials*.json *": deny
    "tail * google-credentials*.json *": deny
    "tail */google-credentials*.json *": deny
    "tail wp-config.php": deny
    "tail wp-config.php *": deny
    "tail * wp-config.php *": deny
    "tail */wp-config.php *": deny
    "tail .npmrc": deny
    "tail .npmrc *": deny
    "tail * .npmrc *": deny
    "tail */.npmrc *": deny
    "tail .netrc": deny
    "tail .netrc *": deny
    "tail * .netrc *": deny
    "tail */.netrc *": deny
    "tail .pypirc": deny
    "tail .pypirc *": deny
    "tail * .pypirc *": deny
    "tail */.pypirc *": deny
    "tail .aws/**": deny
    "tail * .aws/**": deny
    "tail */.aws/**": deny
    "tail .config/gh/**": deny
    "tail * .config/gh/**": deny
    "tail */.config/gh/**": deny
    "tail .docker/config.json": deny
    "tail .docker/config.json *": deny
    "tail * .docker/config.json *": deny
    "tail */.docker/config.json *": deny
    "tail id_rsa": deny
    "tail id_rsa *": deny
    "tail * id_rsa *": deny
    "tail */id_rsa *": deny
    "tail id_ed25519": deny
    "tail id_ed25519 *": deny
    "tail * id_ed25519 *": deny
    "tail */id_ed25519 *": deny
    "tail id_ecdsa": deny
    "tail id_ecdsa *": deny
    "tail * id_ecdsa *": deny
    "tail */id_ecdsa *": deny
    "tail id_dsa": deny
    "tail id_dsa *": deny
    "tail * id_dsa *": deny
    "tail */id_dsa *": deny
    "tail kubeconfig": deny
    "tail kubeconfig *": deny
    "tail * kubeconfig *": deny
    "tail */kubeconfig *": deny
    "tail .kube/**": deny
    "tail * .kube/**": deny
    "tail */.kube/**": deny
    "tail terraform.tfvars": deny
    "tail terraform.tfvars *": deny
    "tail * terraform.tfvars *": deny
    "tail */terraform.tfvars *": deny
    "tail *.tfvars": deny
    "tail *.tfvars *": deny
    "tail terraform.tfstate*": deny
    "tail * terraform.tfstate*": deny
    "tail */terraform.tfstate*": deny
    "tail vault.yml": deny
    "tail vault.yml *": deny
    "tail * vault.yml *": deny
    "tail */vault.yml *": deny
    "tail secrets.yml": deny
    "tail secrets.yml *": deny
    "tail * secrets.yml *": deny
    "tail */secrets.yml *": deny
    "tail master.key": deny
    "tail master.key *": deny
    "tail * master.key *": deny
    "tail */master.key *": deny
    "tail .pgpass": deny
    "tail .pgpass *": deny
    "tail * .pgpass *": deny
    "tail */.pgpass *": deny
    "tail .my.cnf": deny
    "tail .my.cnf *": deny
    "tail * .my.cnf *": deny
    "tail */.my.cnf *": deny
    "tail .envrc": deny
    "tail .envrc *": deny
    "tail * .envrc *": deny
    "tail */.envrc *": deny
    "tail .bash_history": deny
    "tail .bash_history *": deny
    "tail * .bash_history *": deny
    "tail */.bash_history *": deny
    "tail .zsh_history": deny
    "tail .zsh_history *": deny
    "tail * .zsh_history *": deny
    "tail */.zsh_history *": deny
    "tail *.ppk": deny
    "tail *.ppk *": deny
    "tail *.jks": deny
    "tail *.jks *": deny
    "tail Pulumi.*.yaml": deny
    "tail Pulumi.*.yaml *": deny
    "tail * Pulumi.*.yaml *": deny
    "tail */Pulumi.*.yaml *": deny
    "tail mcp.json": deny
    "tail mcp.json *": deny
    "tail * mcp.json *": deny
    "tail */mcp.json *": deny
    "tail .claude.json": deny
    "tail .claude.json *": deny
    "tail * .claude.json *": deny
    "tail */.claude.json *": deny
    "tail .codex/config.toml": deny
    "tail .codex/config.toml *": deny
    "tail * .codex/config.toml *": deny
    "tail */.codex/config.toml *": deny
    "tail .git-credentials": deny
    "tail .git-credentials *": deny
    "tail * .git-credentials *": deny
    "tail */.git-credentials *": deny
    "tail .git/config": deny
    "tail .git/config *": deny
    "tail * .git/config *": deny
    "tail */.git/config *": deny
    "sed .env*": deny
    "sed * .env*": deny
    "sed */.env*": deny
    "sed *.key": deny
    "sed *.key *": deny
    "sed *.pem": deny
    "sed *.pem *": deny
    "sed *.p12": deny
    "sed *.p12 *": deny
    "sed *.pfx": deny
    "sed *.pfx *": deny
    "sed secrets/**": deny
    "sed * secrets/**": deny
    "sed */secrets/**": deny
    "sed .ssh/**": deny
    "sed * .ssh/**": deny
    "sed */.ssh/**": deny
    "sed .gnupg/**": deny
    "sed * .gnupg/**": deny
    "sed */.gnupg/**": deny
    "sed auth.json": deny
    "sed auth.json *": deny
    "sed * auth.json *": deny
    "sed */auth.json *": deny
    "sed service-account*.json": deny
    "sed service-account*.json *": deny
    "sed * service-account*.json *": deny
    "sed */service-account*.json *": deny
    "sed *service-account*.json": deny
    "sed *service-account*.json *": deny
    "sed credentials*.json": deny
    "sed credentials*.json *": deny
    "sed * credentials*.json *": deny
    "sed */credentials*.json *": deny
    "sed *credentials*.json": deny
    "sed *credentials*.json *": deny
    "sed *token*.json": deny
    "sed *token*.json *": deny
    "sed *secret*.json": deny
    "sed *secret*.json *": deny
    "sed firebase-adminsdk*.json": deny
    "sed firebase-adminsdk*.json *": deny
    "sed * firebase-adminsdk*.json *": deny
    "sed */firebase-adminsdk*.json *": deny
    "sed google-credentials*.json": deny
    "sed google-credentials*.json *": deny
    "sed * google-credentials*.json *": deny
    "sed */google-credentials*.json *": deny
    "sed wp-config.php": deny
    "sed wp-config.php *": deny
    "sed * wp-config.php *": deny
    "sed */wp-config.php *": deny
    "sed .npmrc": deny
    "sed .npmrc *": deny
    "sed * .npmrc *": deny
    "sed */.npmrc *": deny
    "sed .netrc": deny
    "sed .netrc *": deny
    "sed * .netrc *": deny
    "sed */.netrc *": deny
    "sed .pypirc": deny
    "sed .pypirc *": deny
    "sed * .pypirc *": deny
    "sed */.pypirc *": deny
    "sed .aws/**": deny
    "sed * .aws/**": deny
    "sed */.aws/**": deny
    "sed .config/gh/**": deny
    "sed * .config/gh/**": deny
    "sed */.config/gh/**": deny
    "sed .docker/config.json": deny
    "sed .docker/config.json *": deny
    "sed * .docker/config.json *": deny
    "sed */.docker/config.json *": deny
    "sed id_rsa": deny
    "sed id_rsa *": deny
    "sed * id_rsa *": deny
    "sed */id_rsa *": deny
    "sed id_ed25519": deny
    "sed id_ed25519 *": deny
    "sed * id_ed25519 *": deny
    "sed */id_ed25519 *": deny
    "sed id_ecdsa": deny
    "sed id_ecdsa *": deny
    "sed * id_ecdsa *": deny
    "sed */id_ecdsa *": deny
    "sed id_dsa": deny
    "sed id_dsa *": deny
    "sed * id_dsa *": deny
    "sed */id_dsa *": deny
    "sed kubeconfig": deny
    "sed kubeconfig *": deny
    "sed * kubeconfig *": deny
    "sed */kubeconfig *": deny
    "sed .kube/**": deny
    "sed * .kube/**": deny
    "sed */.kube/**": deny
    "sed terraform.tfvars": deny
    "sed terraform.tfvars *": deny
    "sed * terraform.tfvars *": deny
    "sed */terraform.tfvars *": deny
    "sed *.tfvars": deny
    "sed *.tfvars *": deny
    "sed terraform.tfstate*": deny
    "sed * terraform.tfstate*": deny
    "sed */terraform.tfstate*": deny
    "sed vault.yml": deny
    "sed vault.yml *": deny
    "sed * vault.yml *": deny
    "sed */vault.yml *": deny
    "sed secrets.yml": deny
    "sed secrets.yml *": deny
    "sed * secrets.yml *": deny
    "sed */secrets.yml *": deny
    "sed master.key": deny
    "sed master.key *": deny
    "sed * master.key *": deny
    "sed */master.key *": deny
    "sed .pgpass": deny
    "sed .pgpass *": deny
    "sed * .pgpass *": deny
    "sed */.pgpass *": deny
    "sed .my.cnf": deny
    "sed .my.cnf *": deny
    "sed * .my.cnf *": deny
    "sed */.my.cnf *": deny
    "sed .envrc": deny
    "sed .envrc *": deny
    "sed * .envrc *": deny
    "sed */.envrc *": deny
    "sed .bash_history": deny
    "sed .bash_history *": deny
    "sed * .bash_history *": deny
    "sed */.bash_history *": deny
    "sed .zsh_history": deny
    "sed .zsh_history *": deny
    "sed * .zsh_history *": deny
    "sed */.zsh_history *": deny
    "sed *.ppk": deny
    "sed *.ppk *": deny
    "sed *.jks": deny
    "sed *.jks *": deny
    "sed Pulumi.*.yaml": deny
    "sed Pulumi.*.yaml *": deny
    "sed * Pulumi.*.yaml *": deny
    "sed */Pulumi.*.yaml *": deny
    "sed mcp.json": deny
    "sed mcp.json *": deny
    "sed * mcp.json *": deny
    "sed */mcp.json *": deny
    "sed .claude.json": deny
    "sed .claude.json *": deny
    "sed * .claude.json *": deny
    "sed */.claude.json *": deny
    "sed .codex/config.toml": deny
    "sed .codex/config.toml *": deny
    "sed * .codex/config.toml *": deny
    "sed */.codex/config.toml *": deny
    "sed .git-credentials": deny
    "sed .git-credentials *": deny
    "sed * .git-credentials *": deny
    "sed */.git-credentials *": deny
    "sed .git/config": deny
    "sed .git/config *": deny
    "sed * .git/config *": deny
    "sed */.git/config *": deny
    "less .env*": deny
    "less * .env*": deny
    "less */.env*": deny
    "less *.key": deny
    "less *.key *": deny
    "less *.pem": deny
    "less *.pem *": deny
    "less *.p12": deny
    "less *.p12 *": deny
    "less *.pfx": deny
    "less *.pfx *": deny
    "less secrets/**": deny
    "less * secrets/**": deny
    "less */secrets/**": deny
    "less .ssh/**": deny
    "less * .ssh/**": deny
    "less */.ssh/**": deny
    "less .gnupg/**": deny
    "less * .gnupg/**": deny
    "less */.gnupg/**": deny
    "less auth.json": deny
    "less auth.json *": deny
    "less * auth.json *": deny
    "less */auth.json *": deny
    "less service-account*.json": deny
    "less service-account*.json *": deny
    "less * service-account*.json *": deny
    "less */service-account*.json *": deny
    "less *service-account*.json": deny
    "less *service-account*.json *": deny
    "less credentials*.json": deny
    "less credentials*.json *": deny
    "less * credentials*.json *": deny
    "less */credentials*.json *": deny
    "less *credentials*.json": deny
    "less *credentials*.json *": deny
    "less *token*.json": deny
    "less *token*.json *": deny
    "less *secret*.json": deny
    "less *secret*.json *": deny
    "less firebase-adminsdk*.json": deny
    "less firebase-adminsdk*.json *": deny
    "less * firebase-adminsdk*.json *": deny
    "less */firebase-adminsdk*.json *": deny
    "less google-credentials*.json": deny
    "less google-credentials*.json *": deny
    "less * google-credentials*.json *": deny
    "less */google-credentials*.json *": deny
    "less wp-config.php": deny
    "less wp-config.php *": deny
    "less * wp-config.php *": deny
    "less */wp-config.php *": deny
    "less .npmrc": deny
    "less .npmrc *": deny
    "less * .npmrc *": deny
    "less */.npmrc *": deny
    "less .netrc": deny
    "less .netrc *": deny
    "less * .netrc *": deny
    "less */.netrc *": deny
    "less .pypirc": deny
    "less .pypirc *": deny
    "less * .pypirc *": deny
    "less */.pypirc *": deny
    "less .aws/**": deny
    "less * .aws/**": deny
    "less */.aws/**": deny
    "less .config/gh/**": deny
    "less * .config/gh/**": deny
    "less */.config/gh/**": deny
    "less .docker/config.json": deny
    "less .docker/config.json *": deny
    "less * .docker/config.json *": deny
    "less */.docker/config.json *": deny
    "less id_rsa": deny
    "less id_rsa *": deny
    "less * id_rsa *": deny
    "less */id_rsa *": deny
    "less id_ed25519": deny
    "less id_ed25519 *": deny
    "less * id_ed25519 *": deny
    "less */id_ed25519 *": deny
    "less id_ecdsa": deny
    "less id_ecdsa *": deny
    "less * id_ecdsa *": deny
    "less */id_ecdsa *": deny
    "less id_dsa": deny
    "less id_dsa *": deny
    "less * id_dsa *": deny
    "less */id_dsa *": deny
    "less kubeconfig": deny
    "less kubeconfig *": deny
    "less * kubeconfig *": deny
    "less */kubeconfig *": deny
    "less .kube/**": deny
    "less * .kube/**": deny
    "less */.kube/**": deny
    "less terraform.tfvars": deny
    "less terraform.tfvars *": deny
    "less * terraform.tfvars *": deny
    "less */terraform.tfvars *": deny
    "less *.tfvars": deny
    "less *.tfvars *": deny
    "less terraform.tfstate*": deny
    "less * terraform.tfstate*": deny
    "less */terraform.tfstate*": deny
    "less vault.yml": deny
    "less vault.yml *": deny
    "less * vault.yml *": deny
    "less */vault.yml *": deny
    "less secrets.yml": deny
    "less secrets.yml *": deny
    "less * secrets.yml *": deny
    "less */secrets.yml *": deny
    "less master.key": deny
    "less master.key *": deny
    "less * master.key *": deny
    "less */master.key *": deny
    "less .pgpass": deny
    "less .pgpass *": deny
    "less * .pgpass *": deny
    "less */.pgpass *": deny
    "less .my.cnf": deny
    "less .my.cnf *": deny
    "less * .my.cnf *": deny
    "less */.my.cnf *": deny
    "less .envrc": deny
    "less .envrc *": deny
    "less * .envrc *": deny
    "less */.envrc *": deny
    "less .bash_history": deny
    "less .bash_history *": deny
    "less * .bash_history *": deny
    "less */.bash_history *": deny
    "less .zsh_history": deny
    "less .zsh_history *": deny
    "less * .zsh_history *": deny
    "less */.zsh_history *": deny
    "less *.ppk": deny
    "less *.ppk *": deny
    "less *.jks": deny
    "less *.jks *": deny
    "less Pulumi.*.yaml": deny
    "less Pulumi.*.yaml *": deny
    "less * Pulumi.*.yaml *": deny
    "less */Pulumi.*.yaml *": deny
    "less mcp.json": deny
    "less mcp.json *": deny
    "less * mcp.json *": deny
    "less */mcp.json *": deny
    "less .claude.json": deny
    "less .claude.json *": deny
    "less * .claude.json *": deny
    "less */.claude.json *": deny
    "less .codex/config.toml": deny
    "less .codex/config.toml *": deny
    "less * .codex/config.toml *": deny
    "less */.codex/config.toml *": deny
    "less .git-credentials": deny
    "less .git-credentials *": deny
    "less * .git-credentials *": deny
    "less */.git-credentials *": deny
    "less .git/config": deny
    "less .git/config *": deny
    "less * .git/config *": deny
    "less */.git/config *": deny
    "more .env*": deny
    "more * .env*": deny
    "more */.env*": deny
    "more *.key": deny
    "more *.key *": deny
    "more *.pem": deny
    "more *.pem *": deny
    "more *.p12": deny
    "more *.p12 *": deny
    "more *.pfx": deny
    "more *.pfx *": deny
    "more secrets/**": deny
    "more * secrets/**": deny
    "more */secrets/**": deny
    "more .ssh/**": deny
    "more * .ssh/**": deny
    "more */.ssh/**": deny
    "more .gnupg/**": deny
    "more * .gnupg/**": deny
    "more */.gnupg/**": deny
    "more auth.json": deny
    "more auth.json *": deny
    "more * auth.json *": deny
    "more */auth.json *": deny
    "more service-account*.json": deny
    "more service-account*.json *": deny
    "more * service-account*.json *": deny
    "more */service-account*.json *": deny
    "more *service-account*.json": deny
    "more *service-account*.json *": deny
    "more credentials*.json": deny
    "more credentials*.json *": deny
    "more * credentials*.json *": deny
    "more */credentials*.json *": deny
    "more *credentials*.json": deny
    "more *credentials*.json *": deny
    "more *token*.json": deny
    "more *token*.json *": deny
    "more *secret*.json": deny
    "more *secret*.json *": deny
    "more firebase-adminsdk*.json": deny
    "more firebase-adminsdk*.json *": deny
    "more * firebase-adminsdk*.json *": deny
    "more */firebase-adminsdk*.json *": deny
    "more google-credentials*.json": deny
    "more google-credentials*.json *": deny
    "more * google-credentials*.json *": deny
    "more */google-credentials*.json *": deny
    "more wp-config.php": deny
    "more wp-config.php *": deny
    "more * wp-config.php *": deny
    "more */wp-config.php *": deny
    "more .npmrc": deny
    "more .npmrc *": deny
    "more * .npmrc *": deny
    "more */.npmrc *": deny
    "more .netrc": deny
    "more .netrc *": deny
    "more * .netrc *": deny
    "more */.netrc *": deny
    "more .pypirc": deny
    "more .pypirc *": deny
    "more * .pypirc *": deny
    "more */.pypirc *": deny
    "more .aws/**": deny
    "more * .aws/**": deny
    "more */.aws/**": deny
    "more .config/gh/**": deny
    "more * .config/gh/**": deny
    "more */.config/gh/**": deny
    "more .docker/config.json": deny
    "more .docker/config.json *": deny
    "more * .docker/config.json *": deny
    "more */.docker/config.json *": deny
    "more id_rsa": deny
    "more id_rsa *": deny
    "more * id_rsa *": deny
    "more */id_rsa *": deny
    "more id_ed25519": deny
    "more id_ed25519 *": deny
    "more * id_ed25519 *": deny
    "more */id_ed25519 *": deny
    "more id_ecdsa": deny
    "more id_ecdsa *": deny
    "more * id_ecdsa *": deny
    "more */id_ecdsa *": deny
    "more id_dsa": deny
    "more id_dsa *": deny
    "more * id_dsa *": deny
    "more */id_dsa *": deny
    "more kubeconfig": deny
    "more kubeconfig *": deny
    "more * kubeconfig *": deny
    "more */kubeconfig *": deny
    "more .kube/**": deny
    "more * .kube/**": deny
    "more */.kube/**": deny
    "more terraform.tfvars": deny
    "more terraform.tfvars *": deny
    "more * terraform.tfvars *": deny
    "more */terraform.tfvars *": deny
    "more *.tfvars": deny
    "more *.tfvars *": deny
    "more terraform.tfstate*": deny
    "more * terraform.tfstate*": deny
    "more */terraform.tfstate*": deny
    "more vault.yml": deny
    "more vault.yml *": deny
    "more * vault.yml *": deny
    "more */vault.yml *": deny
    "more secrets.yml": deny
    "more secrets.yml *": deny
    "more * secrets.yml *": deny
    "more */secrets.yml *": deny
    "more master.key": deny
    "more master.key *": deny
    "more * master.key *": deny
    "more */master.key *": deny
    "more .pgpass": deny
    "more .pgpass *": deny
    "more * .pgpass *": deny
    "more */.pgpass *": deny
    "more .my.cnf": deny
    "more .my.cnf *": deny
    "more * .my.cnf *": deny
    "more */.my.cnf *": deny
    "more .envrc": deny
    "more .envrc *": deny
    "more * .envrc *": deny
    "more */.envrc *": deny
    "more .bash_history": deny
    "more .bash_history *": deny
    "more * .bash_history *": deny
    "more */.bash_history *": deny
    "more .zsh_history": deny
    "more .zsh_history *": deny
    "more * .zsh_history *": deny
    "more */.zsh_history *": deny
    "more *.ppk": deny
    "more *.ppk *": deny
    "more *.jks": deny
    "more *.jks *": deny
    "more Pulumi.*.yaml": deny
    "more Pulumi.*.yaml *": deny
    "more * Pulumi.*.yaml *": deny
    "more */Pulumi.*.yaml *": deny
    "more mcp.json": deny
    "more mcp.json *": deny
    "more * mcp.json *": deny
    "more */mcp.json *": deny
    "more .claude.json": deny
    "more .claude.json *": deny
    "more * .claude.json *": deny
    "more */.claude.json *": deny
    "more .codex/config.toml": deny
    "more .codex/config.toml *": deny
    "more * .codex/config.toml *": deny
    "more */.codex/config.toml *": deny
    "more .git-credentials": deny
    "more .git-credentials *": deny
    "more * .git-credentials *": deny
    "more */.git-credentials *": deny
    "more .git/config": deny
    "more .git/config *": deny
    "more * .git/config *": deny
    "more */.git/config *": deny
    "bat .env*": deny
    "bat * .env*": deny
    "bat */.env*": deny
    "bat *.key": deny
    "bat *.key *": deny
    "bat *.pem": deny
    "bat *.pem *": deny
    "bat *.p12": deny
    "bat *.p12 *": deny
    "bat *.pfx": deny
    "bat *.pfx *": deny
    "bat secrets/**": deny
    "bat * secrets/**": deny
    "bat */secrets/**": deny
    "bat .ssh/**": deny
    "bat * .ssh/**": deny
    "bat */.ssh/**": deny
    "bat .gnupg/**": deny
    "bat * .gnupg/**": deny
    "bat */.gnupg/**": deny
    "bat auth.json": deny
    "bat auth.json *": deny
    "bat * auth.json *": deny
    "bat */auth.json *": deny
    "bat service-account*.json": deny
    "bat service-account*.json *": deny
    "bat * service-account*.json *": deny
    "bat */service-account*.json *": deny
    "bat *service-account*.json": deny
    "bat *service-account*.json *": deny
    "bat credentials*.json": deny
    "bat credentials*.json *": deny
    "bat * credentials*.json *": deny
    "bat */credentials*.json *": deny
    "bat *credentials*.json": deny
    "bat *credentials*.json *": deny
    "bat *token*.json": deny
    "bat *token*.json *": deny
    "bat *secret*.json": deny
    "bat *secret*.json *": deny
    "bat firebase-adminsdk*.json": deny
    "bat firebase-adminsdk*.json *": deny
    "bat * firebase-adminsdk*.json *": deny
    "bat */firebase-adminsdk*.json *": deny
    "bat google-credentials*.json": deny
    "bat google-credentials*.json *": deny
    "bat * google-credentials*.json *": deny
    "bat */google-credentials*.json *": deny
    "bat wp-config.php": deny
    "bat wp-config.php *": deny
    "bat * wp-config.php *": deny
    "bat */wp-config.php *": deny
    "bat .npmrc": deny
    "bat .npmrc *": deny
    "bat * .npmrc *": deny
    "bat */.npmrc *": deny
    "bat .netrc": deny
    "bat .netrc *": deny
    "bat * .netrc *": deny
    "bat */.netrc *": deny
    "bat .pypirc": deny
    "bat .pypirc *": deny
    "bat * .pypirc *": deny
    "bat */.pypirc *": deny
    "bat .aws/**": deny
    "bat * .aws/**": deny
    "bat */.aws/**": deny
    "bat .config/gh/**": deny
    "bat * .config/gh/**": deny
    "bat */.config/gh/**": deny
    "bat .docker/config.json": deny
    "bat .docker/config.json *": deny
    "bat * .docker/config.json *": deny
    "bat */.docker/config.json *": deny
    "bat id_rsa": deny
    "bat id_rsa *": deny
    "bat * id_rsa *": deny
    "bat */id_rsa *": deny
    "bat id_ed25519": deny
    "bat id_ed25519 *": deny
    "bat * id_ed25519 *": deny
    "bat */id_ed25519 *": deny
    "bat id_ecdsa": deny
    "bat id_ecdsa *": deny
    "bat * id_ecdsa *": deny
    "bat */id_ecdsa *": deny
    "bat id_dsa": deny
    "bat id_dsa *": deny
    "bat * id_dsa *": deny
    "bat */id_dsa *": deny
    "bat kubeconfig": deny
    "bat kubeconfig *": deny
    "bat * kubeconfig *": deny
    "bat */kubeconfig *": deny
    "bat .kube/**": deny
    "bat * .kube/**": deny
    "bat */.kube/**": deny
    "bat terraform.tfvars": deny
    "bat terraform.tfvars *": deny
    "bat * terraform.tfvars *": deny
    "bat */terraform.tfvars *": deny
    "bat *.tfvars": deny
    "bat *.tfvars *": deny
    "bat terraform.tfstate*": deny
    "bat * terraform.tfstate*": deny
    "bat */terraform.tfstate*": deny
    "bat vault.yml": deny
    "bat vault.yml *": deny
    "bat * vault.yml *": deny
    "bat */vault.yml *": deny
    "bat secrets.yml": deny
    "bat secrets.yml *": deny
    "bat * secrets.yml *": deny
    "bat */secrets.yml *": deny
    "bat master.key": deny
    "bat master.key *": deny
    "bat * master.key *": deny
    "bat */master.key *": deny
    "bat .pgpass": deny
    "bat .pgpass *": deny
    "bat * .pgpass *": deny
    "bat */.pgpass *": deny
    "bat .my.cnf": deny
    "bat .my.cnf *": deny
    "bat * .my.cnf *": deny
    "bat */.my.cnf *": deny
    "bat .envrc": deny
    "bat .envrc *": deny
    "bat * .envrc *": deny
    "bat */.envrc *": deny
    "bat .bash_history": deny
    "bat .bash_history *": deny
    "bat * .bash_history *": deny
    "bat */.bash_history *": deny
    "bat .zsh_history": deny
    "bat .zsh_history *": deny
    "bat * .zsh_history *": deny
    "bat */.zsh_history *": deny
    "bat *.ppk": deny
    "bat *.ppk *": deny
    "bat *.jks": deny
    "bat *.jks *": deny
    "bat Pulumi.*.yaml": deny
    "bat Pulumi.*.yaml *": deny
    "bat * Pulumi.*.yaml *": deny
    "bat */Pulumi.*.yaml *": deny
    "bat mcp.json": deny
    "bat mcp.json *": deny
    "bat * mcp.json *": deny
    "bat */mcp.json *": deny
    "bat .claude.json": deny
    "bat .claude.json *": deny
    "bat * .claude.json *": deny
    "bat */.claude.json *": deny
    "bat .codex/config.toml": deny
    "bat .codex/config.toml *": deny
    "bat * .codex/config.toml *": deny
    "bat */.codex/config.toml *": deny
    "bat .git-credentials": deny
    "bat .git-credentials *": deny
    "bat * .git-credentials *": deny
    "bat */.git-credentials *": deny
    "bat .git/config": deny
    "bat .git/config *": deny
    "bat * .git/config *": deny
    "bat */.git/config *": deny
    "grep * .env*": deny
    "grep * */.env*": deny
    "grep * *.key": deny
    "grep * */*.key *": deny
    "grep * *.pem": deny
    "grep * */*.pem *": deny
    "grep * *.p12": deny
    "grep * */*.p12 *": deny
    "grep * *.pfx": deny
    "grep * */*.pfx *": deny
    "grep * secrets/**": deny
    "grep * */secrets/**": deny
    "grep * .ssh/**": deny
    "grep * */.ssh/**": deny
    "grep * .gnupg/**": deny
    "grep * */.gnupg/**": deny
    "grep * auth.json": deny
    "grep * */auth.json *": deny
    "grep * service-account*.json": deny
    "grep * */service-account*.json *": deny
    "grep * *service-account*.json": deny
    "grep * */*service-account*.json *": deny
    "grep * credentials*.json": deny
    "grep * */credentials*.json *": deny
    "grep * *credentials*.json": deny
    "grep * */*credentials*.json *": deny
    "grep * *token*.json": deny
    "grep * */*token*.json *": deny
    "grep * *secret*.json": deny
    "grep * */*secret*.json *": deny
    "grep * firebase-adminsdk*.json": deny
    "grep * */firebase-adminsdk*.json *": deny
    "grep * google-credentials*.json": deny
    "grep * */google-credentials*.json *": deny
    "grep * wp-config.php": deny
    "grep * */wp-config.php *": deny
    "grep * .npmrc": deny
    "grep * */.npmrc *": deny
    "grep * .netrc": deny
    "grep * */.netrc *": deny
    "grep * .pypirc": deny
    "grep * */.pypirc *": deny
    "grep * .aws/**": deny
    "grep * */.aws/**": deny
    "grep * .config/gh/**": deny
    "grep * */.config/gh/**": deny
    "grep * .docker/config.json": deny
    "grep * */.docker/config.json *": deny
    "grep * id_rsa": deny
    "grep * */id_rsa *": deny
    "grep * id_ed25519": deny
    "grep * */id_ed25519 *": deny
    "grep * id_ecdsa": deny
    "grep * */id_ecdsa *": deny
    "grep * id_dsa": deny
    "grep * */id_dsa *": deny
    "grep * kubeconfig": deny
    "grep * */kubeconfig *": deny
    "grep * .kube/**": deny
    "grep * */.kube/**": deny
    "grep * terraform.tfvars": deny
    "grep * */terraform.tfvars *": deny
    "grep * *.tfvars": deny
    "grep * */*.tfvars *": deny
    "grep * terraform.tfstate*": deny
    "grep * */terraform.tfstate*": deny
    "grep * vault.yml": deny
    "grep * */vault.yml *": deny
    "grep * secrets.yml": deny
    "grep * */secrets.yml *": deny
    "grep * master.key": deny
    "grep * */master.key *": deny
    "grep * .pgpass": deny
    "grep * */.pgpass *": deny
    "grep * .my.cnf": deny
    "grep * */.my.cnf *": deny
    "grep * .envrc": deny
    "grep * */.envrc *": deny
    "grep * .bash_history": deny
    "grep * */.bash_history *": deny
    "grep * .zsh_history": deny
    "grep * */.zsh_history *": deny
    "grep * *.ppk": deny
    "grep * */*.ppk *": deny
    "grep * *.jks": deny
    "grep * */*.jks *": deny
    "grep * Pulumi.*.yaml": deny
    "grep * */Pulumi.*.yaml *": deny
    "grep * */mcp.json *": deny
    "grep * */.claude.json *": deny
    "grep * */.codex/config.toml *": deny
    "grep * */.git-credentials *": deny
    "grep * */.git/config *": deny
    "rg * .env*": deny
    "rg * */.env*": deny
    "rg * *.key": deny
    "rg * */*.key *": deny
    "rg * *.pem": deny
    "rg * */*.pem *": deny
    "rg * *.p12": deny
    "rg * */*.p12 *": deny
    "rg * *.pfx": deny
    "rg * */*.pfx *": deny
    "rg * secrets/**": deny
    "rg * */secrets/**": deny
    "rg * .ssh/**": deny
    "rg * */.ssh/**": deny
    "rg * .gnupg/**": deny
    "rg * */.gnupg/**": deny
    "rg * auth.json": deny
    "rg * */auth.json *": deny
    "rg * service-account*.json": deny
    "rg * */service-account*.json *": deny
    "rg * *service-account*.json": deny
    "rg * */*service-account*.json *": deny
    "rg * credentials*.json": deny
    "rg * */credentials*.json *": deny
    "rg * *credentials*.json": deny
    "rg * */*credentials*.json *": deny
    "rg * *token*.json": deny
    "rg * */*token*.json *": deny
    "rg * *secret*.json": deny
    "rg * */*secret*.json *": deny
    "rg * firebase-adminsdk*.json": deny
    "rg * */firebase-adminsdk*.json *": deny
    "rg * google-credentials*.json": deny
    "rg * */google-credentials*.json *": deny
    "rg * wp-config.php": deny
    "rg * */wp-config.php *": deny
    "rg * .npmrc": deny
    "rg * */.npmrc *": deny
    "rg * .netrc": deny
    "rg * */.netrc *": deny
    "rg * .pypirc": deny
    "rg * */.pypirc *": deny
    "rg * .aws/**": deny
    "rg * */.aws/**": deny
    "rg * .config/gh/**": deny
    "rg * */.config/gh/**": deny
    "rg * .docker/config.json": deny
    "rg * */.docker/config.json *": deny
    "rg * id_rsa": deny
    "rg * */id_rsa *": deny
    "rg * id_ed25519": deny
    "rg * */id_ed25519 *": deny
    "rg * id_ecdsa": deny
    "rg * */id_ecdsa *": deny
    "rg * id_dsa": deny
    "rg * */id_dsa *": deny
    "rg * kubeconfig": deny
    "rg * */kubeconfig *": deny
    "rg * .kube/**": deny
    "rg * */.kube/**": deny
    "rg * terraform.tfvars": deny
    "rg * */terraform.tfvars *": deny
    "rg * *.tfvars": deny
    "rg * */*.tfvars *": deny
    "rg * terraform.tfstate*": deny
    "rg * */terraform.tfstate*": deny
    "rg * vault.yml": deny
    "rg * */vault.yml *": deny
    "rg * secrets.yml": deny
    "rg * */secrets.yml *": deny
    "rg * master.key": deny
    "rg * */master.key *": deny
    "rg * .pgpass": deny
    "rg * */.pgpass *": deny
    "rg * .my.cnf": deny
    "rg * */.my.cnf *": deny
    "rg * .envrc": deny
    "rg * */.envrc *": deny
    "rg * .bash_history": deny
    "rg * */.bash_history *": deny
    "rg * .zsh_history": deny
    "rg * */.zsh_history *": deny
    "rg * *.ppk": deny
    "rg * */*.ppk *": deny
    "rg * *.jks": deny
    "rg * */*.jks *": deny
    "rg * Pulumi.*.yaml": deny
    "rg * */Pulumi.*.yaml *": deny
    "rg * */mcp.json *": deny
    "rg * */.claude.json *": deny
    "rg * */.codex/config.toml *": deny
    "rg * */.git-credentials *": deny
    "rg * */.git/config *": deny
    "git grep * .env*": deny
    "git grep * */.env*": deny
    "git grep * *.key": deny
    "git grep * */*.key *": deny
    "git grep * *.pem": deny
    "git grep * */*.pem *": deny
    "git grep * *.p12": deny
    "git grep * */*.p12 *": deny
    "git grep * *.pfx": deny
    "git grep * */*.pfx *": deny
    "git grep * secrets/**": deny
    "git grep * */secrets/**": deny
    "git grep * .ssh/**": deny
    "git grep * */.ssh/**": deny
    "git grep * .gnupg/**": deny
    "git grep * */.gnupg/**": deny
    "git grep * auth.json": deny
    "git grep * */auth.json *": deny
    "git grep * service-account*.json": deny
    "git grep * */service-account*.json *": deny
    "git grep * *service-account*.json": deny
    "git grep * */*service-account*.json *": deny
    "git grep * credentials*.json": deny
    "git grep * */credentials*.json *": deny
    "git grep * *credentials*.json": deny
    "git grep * */*credentials*.json *": deny
    "git grep * *token*.json": deny
    "git grep * */*token*.json *": deny
    "git grep * *secret*.json": deny
    "git grep * */*secret*.json *": deny
    "git grep * firebase-adminsdk*.json": deny
    "git grep * */firebase-adminsdk*.json *": deny
    "git grep * google-credentials*.json": deny
    "git grep * */google-credentials*.json *": deny
    "git grep * wp-config.php": deny
    "git grep * */wp-config.php *": deny
    "git grep * .npmrc": deny
    "git grep * */.npmrc *": deny
    "git grep * .netrc": deny
    "git grep * */.netrc *": deny
    "git grep * .pypirc": deny
    "git grep * */.pypirc *": deny
    "git grep * .aws/**": deny
    "git grep * */.aws/**": deny
    "git grep * .config/gh/**": deny
    "git grep * */.config/gh/**": deny
    "git grep * .docker/config.json": deny
    "git grep * */.docker/config.json *": deny
    "git grep * id_rsa": deny
    "git grep * */id_rsa *": deny
    "git grep * id_ed25519": deny
    "git grep * */id_ed25519 *": deny
    "git grep * id_ecdsa": deny
    "git grep * */id_ecdsa *": deny
    "git grep * id_dsa": deny
    "git grep * */id_dsa *": deny
    "git grep * kubeconfig": deny
    "git grep * */kubeconfig *": deny
    "git grep * .kube/**": deny
    "git grep * */.kube/**": deny
    "git grep * terraform.tfvars": deny
    "git grep * */terraform.tfvars *": deny
    "git grep * *.tfvars": deny
    "git grep * */*.tfvars *": deny
    "git grep * terraform.tfstate*": deny
    "git grep * */terraform.tfstate*": deny
    "git grep * vault.yml": deny
    "git grep * */vault.yml *": deny
    "git grep * secrets.yml": deny
    "git grep * */secrets.yml *": deny
    "git grep * master.key": deny
    "git grep * */master.key *": deny
    "git grep * .pgpass": deny
    "git grep * */.pgpass *": deny
    "git grep * .my.cnf": deny
    "git grep * */.my.cnf *": deny
    "git grep * .envrc": deny
    "git grep * */.envrc *": deny
    "git grep * .bash_history": deny
    "git grep * */.bash_history *": deny
    "git grep * .zsh_history": deny
    "git grep * */.zsh_history *": deny
    "git grep * *.ppk": deny
    "git grep * */*.ppk *": deny
    "git grep * *.jks": deny
    "git grep * */*.jks *": deny
    "git grep * Pulumi.*.yaml": deny
    "git grep * */Pulumi.*.yaml *": deny
    "git grep * */mcp.json *": deny
    "git grep * */.claude.json *": deny
    "git grep * */.codex/config.toml *": deny
    "git grep * */.git-credentials *": deny
    "git grep * */.git/config *": deny
  edit:
    "*": ask
    "src/**": allow
    "app/**": allow
    "pages/**": allow
    "components/**": allow
    "lib/**": allow
    "hooks/**": allow
    "utils/**": allow
    "styles/**": allow
    "tests/**": allow
    "test/**": allow
    "__tests__/**": allow
    "e2e/**": allow
    "docs/**": allow
    "scripts/**": allow
    "*.md": allow
    "*.ts": allow
    "*.tsx": allow
    "*.js": allow
    "*.jsx": allow
    "*.css": allow
    "*.scss": allow
    "package.json": ask
    "package-lock.json": ask
    "pnpm-lock.yaml": ask
    "yarn.lock": ask
    "bun.lockb": ask
    "bun.lock": ask
    "AGENTS.md": ask
    "opencode.json": ask
    "opencode.jsonc": ask
    ".opencode/**": ask
    ".github/workflows/**": ask
    "**/.claude/skills/**": ask
    "**/.agents/skills/**": ask
    "**/.config/opencode/skills/**": ask
    ".env*": deny
    "*.env*": deny
    "**/.env*": deny
    "*.key": deny
    "**/*.key": deny
    "*.pem": deny
    "**/*.pem": deny
    "*.p12": deny
    "**/*.p12": deny
    "*.pfx": deny
    "**/*.pfx": deny
    "secrets/**": deny
    "**/secrets/**": deny
    ".ssh/**": deny
    "**/.ssh/**": deny
    ".gnupg/**": deny
    "**/.gnupg/**": deny
    "auth.json": deny
    "**/auth.json": deny
    "service-account*.json": deny
    "**/service-account*.json": deny
    "*service-account*.json": deny
    "**/*service-account*.json": deny
    "credentials*.json": deny
    "**/credentials*.json": deny
    "*credentials*.json": deny
    "**/*credentials*.json": deny
    "*token*.json": deny
    "**/*token*.json": deny
    "*secret*.json": deny
    "**/*secret*.json": deny
    "firebase-adminsdk*.json": deny
    "**/firebase-adminsdk*.json": deny
    "google-credentials*.json": deny
    "**/google-credentials*.json": deny
    "wp-config.php": deny
    "**/wp-config.php": deny
    ".npmrc": deny
    "**/.npmrc": deny
    ".netrc": deny
    "**/.netrc": deny
    ".pypirc": deny
    "**/.pypirc": deny
    ".aws/**": deny
    "**/.aws/**": deny
    ".config/gh/**": deny
    "**/.config/gh/**": deny
    ".docker/config.json": deny
    "**/.docker/config.json": deny
    "id_rsa": deny
    "**/id_rsa": deny
    "id_ed25519": deny
    "**/id_ed25519": deny
    "id_ecdsa": deny
    "**/id_ecdsa": deny
    "id_dsa": deny
    "**/id_dsa": deny
    "kubeconfig": deny
    "**/kubeconfig": deny
    ".kube/**": deny
    "**/.kube/**": deny
    "terraform.tfvars": deny
    "**/terraform.tfvars": deny
    "*.tfvars": deny
    "**/*.tfvars": deny
    "terraform.tfstate*": deny
    "**/terraform.tfstate*": deny
    "vault.yml": deny
    "**/vault.yml": deny
    "secrets.yml": deny
    "**/secrets.yml": deny
    "master.key": deny
    "**/master.key": deny
    ".pgpass": deny
    "**/.pgpass": deny
    ".my.cnf": deny
    "**/.my.cnf": deny
    ".envrc": deny
    "**/.envrc": deny
    ".bash_history": deny
    "**/.bash_history": deny
    ".zsh_history": deny
    "**/.zsh_history": deny
    "*.ppk": deny
    "**/*.ppk": deny
    "*.jks": deny
    "**/*.jks": deny
    "Pulumi.*.yaml": deny
    "**/Pulumi.*.yaml": deny
    ".env.example": allow
    "**/.env.example": allow
    ".env.sample": allow
    "**/.env.sample": allow
    ".env.template": allow
    "**/.env.template": allow
    "example.env": allow
    "**/example.env": allow
---

You are the user's default autonomous coding architect/orchestrator.

Core behavior:
- Ask a clarifying question only when a choice materially affects architecture, scope, risk, data, or deployment, or when the work is impossible or unsafe.
- Otherwise make bounded assumptions and state them in the final report.
- Prefer repository reality over memory, stale docs, or assumptions.
- Inspect relevant files before implementation.
- Use available skills when they match the task.
- Delegate to subagents when that reduces risk, context load, or verification burden.
- Keep work bounded to the user's request.
- Prefer small, safe diffs and existing project patterns.
- Never print secrets or edit credential-bearing files.
- Do not run destructive commands or push without approval.

Command policy:
- When running allow-listed verification commands, run the plain command without shell redirects, pipes, command chaining, or output wrappers.
- Prefer the repo's own exact verification commands (for example `npm run test`, `make test`, `cargo test`, `pytest`, or `go test ./...`).
- Do not append `2>&1`, `| head`, `| tail`, `&&`, `;`, `||`, output redirection, or similar shell syntax unless the user explicitly asks for it or approval is expected.
- For directory and status checks, prefer plain commands such as `ls dist`, `git status --short`, and `git diff --stat`.
- If a command requires approval only because of shell wrapping, rerun it as the plain allow-listed command instead of asking for approval.
- Do not use shell wrappers to make output shorter. Let OpenCode display or collapse long output normally.

Delegation policy:
- Use repo-scout before implementation when structure, ownership, relevant files, or repo conventions are unclear.
- Use inspector after non-trivial implementation before commit/report.
- Use sentinel for auth, permissions, payments, forms, uploads, API routes, database access, privileged credentials, secrets, shell execution, webhooks, and user data.
- Use scribe when code changes require README, docs, runbook, QA checklist, usage notes, or operator docs.
- Use verifier after implementation to run relevant non-destructive verification.
- Use built-in explore for quick read-only codebase search.

Implementation workflow:
1. Restate the objective internally.
2. Inspect files and existing conventions.
3. Create a concise patch plan.
4. Implement the smallest safe change.
5. Run relevant verification.
6. Review the diff.
7. Commit only when the user requested a commit.
8. Final report: follow the Final report section of the rules, with the commit hash if you committed.

When committing:
- Use clear English commit messages.
- Do not include secrets or private values in commit messages.
- Do not push unless explicitly approved.
