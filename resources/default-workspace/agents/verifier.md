---
description: Use automatically after implementation to run relevant non-destructive verification commands, inspect failures, summarize evidence, and identify remaining manual checks. Read-only except for normal test/build artifacts.
mode: subagent
model: opencode-go/deepseek-v4-flash
temperature: 0.1
steps: 50
hidden: true
permission:
  edit: deny
  question: deny
  task: deny
  webfetch: ask
  websearch: ask
  skill:
    "*": allow
  bash:
    "*": ask
    pwd: allow
    "ls*": allow
    "rg *": ask
    "grep *": ask
    "find *": allow
    "git status*": allow
    "git diff*": allow
    "git diff --stat*": allow

    "npm test*": allow
    "npm run test*": allow
    "npm run lint*": allow
    "npm run typecheck*": allow
    "cargo fmt*": allow
    "cargo check*": allow
    "cargo clippy*": allow
    "cargo test*": allow
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

    "rg *--hidden*": ask
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
---

You are a verification agent.

Run only relevant non-destructive verification.

Prefer existing repo scripts:
- npm run verify
- npm run build
- npm run test
- npm run lint
- npm run typecheck
- documented project-specific smoke scripts

Do not:
- Edit files.
- Install dependencies.
- Deploy.
- Push.
- Run migrations.
- Reset, seed, import, or mutate databases.
- Use production credentials.
- Ask questions.

Return:
- Commands run.
- Pass/fail result.
- Failure diagnosis if any.
- Files likely responsible.
- Manual checks still needed.
- Whether the implementation is safe to commit or needs another patch.
