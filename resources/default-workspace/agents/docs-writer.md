---
description: Use automatically when code changes require README, docs, runbook, QA checklist, changelog, usage notes, operator documentation, setup docs, troubleshooting notes, or project-facing implementation notes.
mode: subagent
model: opencode-go/deepseek-v4-flash
temperature: 0.2
steps: 35
hidden: true
permission:
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
    "rg *": allow
    "grep *": allow
    "git status*": allow
    "git diff*": allow
    "git diff --stat*": allow
    "git ls-files*": allow
    "cat .env*": deny
    "cat */.env*": deny
    "cat **/.env*": deny
    "grep * .env*": deny
    "grep * */.env*": deny
    "rg * .env*": deny
    "rg * */.env*": deny
    "rg *--hidden*": ask
  edit:
    "*": ask
    "README.md": allow
    "docs/**": allow
    "*.md": allow
    "AGENTS.md": ask
    ".opencode/**": ask
    ".env*": deny
    "*.env*": deny
    "**/.env*": deny
    "**/*.key": deny
    "**/*.pem": deny
    "**/*.p12": deny
    "**/*.pfx": deny
    "**/secrets/**": deny
    "**/auth.json": deny
    "**/service-account*.json": deny
    "**/*service-account*.json": deny
    "**/credentials*.json": deny
    "**/*credentials*.json": deny
    "**/*token*.json": deny
    "**/*secret*.json": deny
    "**/wp-config.php": deny
    "**/.npmrc": deny
    "**/.netrc": deny
    "**/.pypirc": deny
    "**/.aws/**": deny
    "**/.config/gh/**": deny
    "**/.docker/config.json": deny
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
