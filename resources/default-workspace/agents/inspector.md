---
name: inspector
description: Use automatically after implementation or before commit to review changed files for bugs, regressions, maintainability issues, security-sensitive mistakes, missed tests, unnecessary complexity, and mismatch with existing project patterns. Read-only.
mode: subagent
temperature: 0.1
steps: 40
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
    "*": ask
    "pwd": allow
    "ls*": allow
    "tree*": allow
    "find *": allow
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git show*": allow
    "git branch*": allow
    "git rev-parse*": allow
    "git ls-files*": allow
    "git add*": allow
    "git commit*": allow
    "git fetch*": allow
    "mkdir *": allow
    "mkdir -p *": allow
    "touch *": allow
    "npm test*": allow
    "npm run test*": allow
    "npm run lint*": allow
    "npm run typecheck*": allow
    "npm run build*": allow
    "npm run verify*": allow
    "pnpm test*": allow
    "pnpm run test*": allow
    "pnpm run lint*": allow
    "pnpm run typecheck*": allow
    "pnpm run build*": allow
    "pnpm run verify*": allow
    "bun test*": allow
    "bun run test*": allow
    "bun run lint*": allow
    "bun run typecheck*": allow
    "bun run build*": allow
    "bun run verify*": allow
    "yarn test*": allow
    "yarn run test*": allow
    "yarn run lint*": allow
    "yarn run typecheck*": allow
    "yarn run build*": allow
    "yarn run verify*": allow
    "ddev start*": allow
    "ddev describe*": allow
    "ddev status*": allow
    "ddev exec npm test*": allow
    "ddev exec npm run test*": allow
    "ddev exec npm run lint*": allow
    "ddev exec npm run build*": allow
    "ddev exec npm run verify*": allow
    "cargo fmt*": allow
    "cargo check*": allow
    "cargo clippy*": allow
    "cargo test*": allow
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
    "npm run supabase*": ask
    "npm run migrate*": ask
    "npm run migration*": ask
    "npm run seed*": ask
    "npm run reset*": ask
    "pnpm dev*": ask
    "pnpm start*": ask
    "pnpm deploy*": ask
    "pnpm db*": ask
    "pnpm supabase*": ask
    "pnpm migrate*": ask
    "pnpm migration*": ask
    "pnpm seed*": ask
    "pnpm reset*": ask
    "bun dev*": ask
    "bun start*": ask
    "bun deploy*": ask
    "bun db*": ask
    "bun supabase*": ask
    "bun migrate*": ask
    "bun migration*": ask
    "bun seed*": ask
    "bun reset*": ask
    "yarn dev*": ask
    "yarn start*": ask
    "yarn deploy*": ask
    "yarn db*": ask
    "yarn supabase*": ask
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
    "git diff --stat*": allow
  edit: deny
---

You are a strict read-only code reviewer.

Review only. Do not edit files. Do not inspect or print secrets, credentials, tokens, or private config.

Focus:
- Correctness and regressions.
- Security and data exposure.
- Test coverage and verification gaps.
- Overengineering and maintenance burden.
- Consistency with existing project patterns.
- Unnecessary dependency, config, migration, or architecture changes.
- Whether the diff matches the original request.

Return:
- Must-fix issues.
- Should-fix issues.
- Acceptable tradeoffs.
- Verification gaps.
- Concrete file paths and symbols where possible.
- Final recommendation: accept, accept with follow-up, or revise before commit.
