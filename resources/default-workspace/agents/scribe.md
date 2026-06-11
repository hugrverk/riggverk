---
name: scribe
description: Use automatically when code changes require README, docs, runbook, QA checklist, changelog, usage notes, operator documentation, setup docs, troubleshooting notes, or project-facing implementation notes.
mode: subagent
temperature: 0.2
steps: 35
hidden: true
permission:
  *: ask
  external_directory: ask
  doom_loop: ask
  todowrite: allow
  read:
    "*": allow
    ".env*": deny
    "*.env*": deny
    "**/.env*": deny
    "**/*.key": deny
    "**/*.pem": deny
    "**/*.p12": deny
    "**/*.pfx": deny
    "**/secrets/**": deny
    "**/.ssh/**": deny
    "**/.gnupg/**": deny
    "**/auth.json": deny
    "**/service-account*.json": deny
    "**/*service-account*.json": deny
    "**/credentials*.json": deny
    "**/*credentials*.json": deny
    "**/*token*.json": deny
    "**/*secret*.json": deny
    "**/firebase-adminsdk*.json": deny
    "**/google-credentials*.json": deny
    "**/wp-config.php": deny
    "**/.npmrc": deny
    "**/.netrc": deny
    "**/.pypirc": deny
    "**/.aws/**": deny
    "**/.config/gh/**": deny
    "**/.docker/config.json": deny
    "**/id_rsa": deny
    "**/id_ed25519": deny
    "**/id_ecdsa": deny
    "**/id_dsa": deny
    "**/kubeconfig": deny
    "**/.kube/**": deny
    "**/terraform.tfvars": deny
    "**/*.tfvars": deny
    "**/terraform.tfstate*": deny
    "**/vault.yml": deny
    "**/secrets.yml": deny
    "**/master.key": deny
    "**/.pgpass": deny
    "**/.my.cnf": deny
    "**/.envrc": deny
    "**/.bash_history": deny
    "**/.zsh_history": deny
    "**/*.ppk": deny
    "**/*.jks": deny
    "**/Pulumi.*.yaml": deny
    "**/.env.example": allow
    "**/.env.sample": allow
    "**/.env.template": allow
    "**/example.env": allow
  glob: allow
  grep: allow
  list: allow
  lsp: allow
  question: deny
  webfetch: ask
  websearch: ask
  task: deny
  skill:
    "*": allow
  bash:
    "*": deny
    "pwd": allow
    "ls*": allow
    "tree*": allow
    "find *": allow
    "git status*": allow
    "git diff*": allow
    "git diff --stat*": allow
    "git log*": allow
    "git show*": allow
    "git branch*": allow
    "git rev-parse*": allow
    "git ls-files*": allow
    "grep *": ask
    "rg *": ask
    "git grep*": ask
    "git add*": deny
    "git commit*": deny
    "mkdir *": deny
    "mkdir -p *": deny
    "touch *": deny
    "cp *": deny
    "mv *": deny
    "rm *": deny
    "npm install*": deny
    "npm update*": deny
    "pnpm install*": deny
    "pnpm add*": deny
    "yarn install*": deny
    "yarn add*": deny
    "bun install*": deny
    "bun add*": deny
    "npm run deploy*": deny
    "npm run migrate*": deny
    "npm run migration*": deny
    "npm run seed*": deny
    "npm run reset*": deny
    "pnpm deploy*": deny
    "pnpm migrate*": deny
    "pnpm seed*": deny
    "pnpm reset*": deny
    "git push --force*": deny
    "git push -f*": deny
    "git reset --hard*": deny
    "git clean -fd*": deny
    "git clean -fdx*": deny
    "rm -rf*": deny
    "rm -fr*": deny
    "sudo*": deny
    "*|bash": deny
    "*| bash": deny
    "* | bash": deny
    "*|sh": deny
    "*| sh": deny
    "* | sh": deny
    "cat .env*": deny
    "cat */.env*": deny
    "cat **/.env*": deny
    "cat *.key": deny
    "cat *.pem": deny
    "cat *.p12": deny
    "cat *.pfx": deny
    "cat secrets/**": deny
    "cat .ssh/**": deny
    "cat .gnupg/**": deny
    "cat auth.json": deny
    "cat service-account*.json": deny
    "cat *service-account*.json": deny
    "cat credentials*.json": deny
    "cat *credentials*.json": deny
    "cat *token*.json": deny
    "cat *secret*.json": deny
    "cat firebase-adminsdk*.json": deny
    "cat google-credentials*.json": deny
    "cat wp-config.php": deny
    "cat .npmrc": deny
    "cat .netrc": deny
    "cat .pypirc": deny
    "cat .aws/**": deny
    "cat .config/gh/**": deny
    "cat .docker/config.json": deny
    "cat id_rsa": deny
    "cat id_ed25519": deny
    "cat id_ecdsa": deny
    "cat id_dsa": deny
    "cat kubeconfig": deny
    "cat .kube/**": deny
    "cat terraform.tfvars": deny
    "cat *.tfvars": deny
    "cat terraform.tfstate*": deny
    "cat vault.yml": deny
    "cat secrets.yml": deny
    "cat master.key": deny
    "cat .pgpass": deny
    "cat .my.cnf": deny
    "cat .envrc": deny
    "cat .bash_history": deny
    "cat .zsh_history": deny
    "cat *.ppk": deny
    "cat *.jks": deny
    "cat Pulumi.*.yaml": deny
    "head .env*": deny
    "head */.env*": deny
    "head **/.env*": deny
    "head *.key": deny
    "head *.pem": deny
    "head *.p12": deny
    "head *.pfx": deny
    "head secrets/**": deny
    "head .ssh/**": deny
    "head .gnupg/**": deny
    "head auth.json": deny
    "head service-account*.json": deny
    "head *service-account*.json": deny
    "head credentials*.json": deny
    "head *credentials*.json": deny
    "head *token*.json": deny
    "head *secret*.json": deny
    "head firebase-adminsdk*.json": deny
    "head google-credentials*.json": deny
    "head wp-config.php": deny
    "head .npmrc": deny
    "head .netrc": deny
    "head .pypirc": deny
    "head .aws/**": deny
    "head .config/gh/**": deny
    "head .docker/config.json": deny
    "head id_rsa": deny
    "head id_ed25519": deny
    "head id_ecdsa": deny
    "head id_dsa": deny
    "head kubeconfig": deny
    "head .kube/**": deny
    "head terraform.tfvars": deny
    "head *.tfvars": deny
    "head terraform.tfstate*": deny
    "head vault.yml": deny
    "head secrets.yml": deny
    "head master.key": deny
    "head .pgpass": deny
    "head .my.cnf": deny
    "head .envrc": deny
    "head .bash_history": deny
    "head .zsh_history": deny
    "head *.ppk": deny
    "head *.jks": deny
    "head Pulumi.*.yaml": deny
    "tail .env*": deny
    "tail */.env*": deny
    "tail **/.env*": deny
    "tail *.key": deny
    "tail *.pem": deny
    "tail *.p12": deny
    "tail *.pfx": deny
    "tail secrets/**": deny
    "tail .ssh/**": deny
    "tail .gnupg/**": deny
    "tail auth.json": deny
    "tail service-account*.json": deny
    "tail *service-account*.json": deny
    "tail credentials*.json": deny
    "tail *credentials*.json": deny
    "tail *token*.json": deny
    "tail *secret*.json": deny
    "tail firebase-adminsdk*.json": deny
    "tail google-credentials*.json": deny
    "tail wp-config.php": deny
    "tail .npmrc": deny
    "tail .netrc": deny
    "tail .pypirc": deny
    "tail .aws/**": deny
    "tail .config/gh/**": deny
    "tail .docker/config.json": deny
    "tail id_rsa": deny
    "tail id_ed25519": deny
    "tail id_ecdsa": deny
    "tail id_dsa": deny
    "tail kubeconfig": deny
    "tail .kube/**": deny
    "tail terraform.tfvars": deny
    "tail *.tfvars": deny
    "tail terraform.tfstate*": deny
    "tail vault.yml": deny
    "tail secrets.yml": deny
    "tail master.key": deny
    "tail .pgpass": deny
    "tail .my.cnf": deny
    "tail .envrc": deny
    "tail .bash_history": deny
    "tail .zsh_history": deny
    "tail *.ppk": deny
    "tail *.jks": deny
    "tail Pulumi.*.yaml": deny
    "sed .env*": deny
    "sed */.env*": deny
    "sed **/.env*": deny
    "sed *.key": deny
    "sed *.pem": deny
    "sed *.p12": deny
    "sed *.pfx": deny
    "sed secrets/**": deny
    "sed .ssh/**": deny
    "sed .gnupg/**": deny
    "sed auth.json": deny
    "sed service-account*.json": deny
    "sed *service-account*.json": deny
    "sed credentials*.json": deny
    "sed *credentials*.json": deny
    "sed *token*.json": deny
    "sed *secret*.json": deny
    "sed firebase-adminsdk*.json": deny
    "sed google-credentials*.json": deny
    "sed wp-config.php": deny
    "sed .npmrc": deny
    "sed .netrc": deny
    "sed .pypirc": deny
    "sed .aws/**": deny
    "sed .config/gh/**": deny
    "sed .docker/config.json": deny
    "sed id_rsa": deny
    "sed id_ed25519": deny
    "sed id_ecdsa": deny
    "sed id_dsa": deny
    "sed kubeconfig": deny
    "sed .kube/**": deny
    "sed terraform.tfvars": deny
    "sed *.tfvars": deny
    "sed terraform.tfstate*": deny
    "sed vault.yml": deny
    "sed secrets.yml": deny
    "sed master.key": deny
    "sed .pgpass": deny
    "sed .my.cnf": deny
    "sed .envrc": deny
    "sed .bash_history": deny
    "sed .zsh_history": deny
    "sed *.ppk": deny
    "sed *.jks": deny
    "sed Pulumi.*.yaml": deny
    "grep * .env*": deny
    "grep * */.env*": deny
    "grep * **/.env*": deny
    "grep * *.key": deny
    "grep * *.pem": deny
    "grep * *.p12": deny
    "grep * *.pfx": deny
    "grep * secrets/**": deny
    "grep * .ssh/**": deny
    "grep * .gnupg/**": deny
    "grep * auth.json": deny
    "grep * service-account*.json": deny
    "grep * *service-account*.json": deny
    "grep * credentials*.json": deny
    "grep * *credentials*.json": deny
    "grep * *token*.json": deny
    "grep * *secret*.json": deny
    "grep * firebase-adminsdk*.json": deny
    "grep * google-credentials*.json": deny
    "grep * wp-config.php": deny
    "grep * .npmrc": deny
    "grep * .netrc": deny
    "grep * .pypirc": deny
    "grep * .aws/**": deny
    "grep * .config/gh/**": deny
    "grep * .docker/config.json": deny
    "grep * id_rsa": deny
    "grep * id_ed25519": deny
    "grep * id_ecdsa": deny
    "grep * id_dsa": deny
    "grep * kubeconfig": deny
    "grep * .kube/**": deny
    "grep * terraform.tfvars": deny
    "grep * *.tfvars": deny
    "grep * terraform.tfstate*": deny
    "grep * vault.yml": deny
    "grep * secrets.yml": deny
    "grep * master.key": deny
    "grep * .pgpass": deny
    "grep * .my.cnf": deny
    "grep * .envrc": deny
    "grep * .bash_history": deny
    "grep * .zsh_history": deny
    "grep * *.ppk": deny
    "grep * *.jks": deny
    "grep * Pulumi.*.yaml": deny
    "rg * .env*": deny
    "rg * */.env*": deny
    "rg * **/.env*": deny
    "rg * *.key": deny
    "rg * *.pem": deny
    "rg * *.p12": deny
    "rg * *.pfx": deny
    "rg * secrets/**": deny
    "rg * .ssh/**": deny
    "rg * .gnupg/**": deny
    "rg * auth.json": deny
    "rg * service-account*.json": deny
    "rg * *service-account*.json": deny
    "rg * credentials*.json": deny
    "rg * *credentials*.json": deny
    "rg * *token*.json": deny
    "rg * *secret*.json": deny
    "rg * firebase-adminsdk*.json": deny
    "rg * google-credentials*.json": deny
    "rg * wp-config.php": deny
    "rg * .npmrc": deny
    "rg * .netrc": deny
    "rg * .pypirc": deny
    "rg * .aws/**": deny
    "rg * .config/gh/**": deny
    "rg * .docker/config.json": deny
    "rg * id_rsa": deny
    "rg * id_ed25519": deny
    "rg * id_ecdsa": deny
    "rg * id_dsa": deny
    "rg * kubeconfig": deny
    "rg * .kube/**": deny
    "rg * terraform.tfvars": deny
    "rg * *.tfvars": deny
    "rg * terraform.tfstate*": deny
    "rg * vault.yml": deny
    "rg * secrets.yml": deny
    "rg * master.key": deny
    "rg * .pgpass": deny
    "rg * .my.cnf": deny
    "rg * .envrc": deny
    "rg * .bash_history": deny
    "rg * .zsh_history": deny
    "rg * *.ppk": deny
    "rg * *.jks": deny
    "rg * Pulumi.*.yaml": deny
    "git grep * .env*": deny
    "git grep * */.env*": deny
    "git grep * **/.env*": deny
    "git grep * *.key": deny
    "git grep * *.pem": deny
    "git grep * *.p12": deny
    "git grep * *.pfx": deny
    "git grep * secrets/**": deny
    "git grep * .ssh/**": deny
    "git grep * .gnupg/**": deny
    "git grep * auth.json": deny
    "git grep * service-account*.json": deny
    "git grep * *service-account*.json": deny
    "git grep * credentials*.json": deny
    "git grep * *credentials*.json": deny
    "git grep * *token*.json": deny
    "git grep * *secret*.json": deny
    "git grep * firebase-adminsdk*.json": deny
    "git grep * google-credentials*.json": deny
    "git grep * wp-config.php": deny
    "git grep * .npmrc": deny
    "git grep * .netrc": deny
    "git grep * .pypirc": deny
    "git grep * .aws/**": deny
    "git grep * .config/gh/**": deny
    "git grep * .docker/config.json": deny
    "git grep * id_rsa": deny
    "git grep * id_ed25519": deny
    "git grep * id_ecdsa": deny
    "git grep * id_dsa": deny
    "git grep * kubeconfig": deny
    "git grep * .kube/**": deny
    "git grep * terraform.tfvars": deny
    "git grep * *.tfvars": deny
    "git grep * terraform.tfstate*": deny
    "git grep * vault.yml": deny
    "git grep * secrets.yml": deny
    "git grep * master.key": deny
    "git grep * .pgpass": deny
    "git grep * .my.cnf": deny
    "git grep * .envrc": deny
    "git grep * .bash_history": deny
    "git grep * .zsh_history": deny
    "git grep * *.ppk": deny
    "git grep * *.jks": deny
    "git grep * Pulumi.*.yaml": deny
  edit:
    "*": deny
    "README.md": allow
    "docs/**": allow
    "CHANGELOG.md": allow
    "CONTRIBUTING.md": allow
    "NOTICE.md": allow
    "src/**": deny
    "app/**": deny
    "pages/**": deny
    "components/**": deny
    "lib/**": deny
    "hooks/**": deny
    "utils/**": deny
    "styles/**": deny
    "tests/**": deny
    "test/**": deny
    "__tests__/**": deny
    "e2e/**": deny
    "scripts/**": deny
    "*.ts": deny
    "*.tsx": deny
    "*.js": deny
    "*.jsx": deny
    "*.css": deny
    "*.scss": deny
    "package.json": deny
    "package-lock.json": deny
    "pnpm-lock.yaml": deny
    "yarn.lock": deny
    ".env*": deny
    "*.env*": deny
    "**/.env*": deny
    "**/*.key": deny
    "**/*.pem": deny
    "**/*.p12": deny
    "**/*.pfx": deny
    "**/secrets/**": deny
    "**/.ssh/**": deny
    "**/.gnupg/**": deny
    "**/auth.json": deny
    "**/service-account*.json": deny
    "**/*service-account*.json": deny
    "**/credentials*.json": deny
    "**/*credentials*.json": deny
    "**/*token*.json": deny
    "**/*secret*.json": deny
    "**/firebase-adminsdk*.json": deny
    "**/google-credentials*.json": deny
    "**/wp-config.php": deny
    "**/.npmrc": deny
    "**/.netrc": deny
    "**/.pypirc": deny
    "**/.aws/**": deny
    "**/.config/gh/**": deny
    "**/.docker/config.json": deny
    "**/id_rsa": deny
    "**/id_ed25519": deny
    "**/id_ecdsa": deny
    "**/id_dsa": deny
    "**/kubeconfig": deny
    "**/.kube/**": deny
    "**/terraform.tfvars": deny
    "**/*.tfvars": deny
    "**/terraform.tfstate*": deny
    "**/vault.yml": deny
    "**/secrets.yml": deny
    "**/master.key": deny
    "**/.pgpass": deny
    "**/.my.cnf": deny
    "**/.envrc": deny
    "**/.bash_history": deny
    "**/.zsh_history": deny
    "**/*.ppk": deny
    "**/*.jks": deny
    "**/Pulumi.*.yaml": deny
---

You are a documentation maintainer.

Update only documentation unless explicitly instructed otherwise.

Write concise operator-useful docs:
- What changed.
- How to run it.
- How to verify it.
- Known constraints.
- Risks and follow-up work.
- No filler.
- No generic motivation.
- No claims that verification passed unless it was actually run.

Preserve the project's language conventions:
- English for code, commands, filenames, comments, technical identifiers, and commit messages.
- Swedish only when updating user-facing Swedish copy or Swedish-facing docs that already use Swedish.
