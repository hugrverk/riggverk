#!/usr/bin/env python3
"""Semantic validation of composed OpenCode agent permission boundaries."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from opencode_permission_eval import (  # noqa: E402
    bash_is_allowed,
    edit_is_allowed,
    effective_bash_action,
    effective_edit_action,
    effective_read_action,
    winning_rule,
)
from opencode_policy_compose import compose_opencode_header, compose_role_permission, load_policy  # noqa: E402

ROLES_DIR = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode" / "agents"
AGENTS_DIR = REPO_ROOT / "resources" / "default-workspace" / "agents"
POLICY_PATH = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode.policy.json"

READONLY_ROLES = ("repo-scout", "inspector", "sentinel")
ALL_ROLES = ("architect", "repo-scout", "inspector", "sentinel", "scribe", "verifier")
RESTRICTIVE_ROLES = READONLY_ROLES + ("scribe", "verifier")

SECRET_READ = ["**/.env*", "**/id_rsa"]
# Credential-bearing config: read-denied only (edit stays path-relative, see opencode.policy.json).
CREDENTIAL_CONFIG_READ = [
    "**/mcp.json",
    "**/.claude.json",
    "**/.codex/config.toml",
    "**/.git-credentials",
    "**/.git/config",
]
# Effective read action per absolute path (last match wins, like OpenCode).
READ_ACTIONS = [
    ("/repo/.env", "deny"),
    ("/repo/src/.env.local", "deny"),
    ("/home/u/.ssh/id_rsa", "deny"),
    ("/home/u/.cursor/mcp.json", "deny"),
    ("/home/u/.claude.json", "deny"),
    ("/home/u/.codex/config.toml", "deny"),
    ("/home/u/.git-credentials", "deny"),
    ("/repo/.git/config", "deny"),
    ("/repo/.env.example", "allow"),
    ("/repo/src/App.tsx", "allow"),
]
DESTRUCTIVE_BASH = ["rm -rf*", "sudo*", "git reset --hard*", "git push --force*"]

READONLY_BASH_DENY = [
    "git add .",
    "git commit -m test",
    "git branch temporary-branch",
    "git branch -D temporary-branch",
    "mkdir changed",
    "touch changed.txt",
    "cp source destination",
    "mv source destination",
    "rm file",
    "find . -delete",
    "find . -exec touch changed.txt ;",
    "git status & touch changed.txt",
    "git status\ntouch changed.txt",
    "git status\rtouch changed.txt",
    "ls <(touch changed.txt)",
    "ls >(touch changed.txt)",
    "git status < changed.txt",
    "git diff > changed.txt",
    "git diff >> changed.txt",
    "git status > changed.txt",
    "ls > changed.txt",
    "git status | sh",
    "git status | bash",
    "git status && touch changed.txt",
    "git status || touch changed.txt",
    "git status ; touch changed.txt",
    "echo $(touch changed.txt)",
    "echo `touch changed.txt`",
    "tree -o changed.txt",
    "git diff --output=changed.txt",
    "git diff --ext-diff",
    "git diff --textconv",
    "git log --output=changed.txt",
    "git show --output=changed.txt",
    "git show --ext-diff",
    "git checkout main",
    "git switch main",
    "git restore .",
    "git reset HEAD",
    "git clean -fd",
    "git stash",
    "git tag v1",
    "git fetch",
    "git pull",
    "npm install",
    "npm test",
    "cargo check",
]

VERIFIER_FORBIDDEN = [
    cmd
    for cmd in READONLY_BASH_DENY
    if cmd not in {"npm test", "cargo check"}
] + [
    "cargo fmt",
    "cargo fmt --all",
    "cargo clippy --fix",
    "cargo clippy --fix --allow-dirty",
    "cargo fmt --check -- --emit files",
    "npm run lint -- --fix",
    "pnpm run lint -- --fix",
    "yarn run lint --fix",
    "bun run lint --fix",
    "npm test -- --updateSnapshot",
    "pnpm test -- --updateSnapshot",
    "yarn test --updateSnapshot",
    "bun test --updateSnapshot",
    "npm test -- -u",
    "pnpm test -- -u",
    "yarn test -u",
    "bun test -u",
    "npm test -- --update",
    "npm run build -- --outDir src",
    "npm run typecheck -- --outDir src",
    "npm run verify -- --fix",
    "cargo test -- --update",
    "npm run deploy",
    "npm run migrate",
]

VERIFIER_REQUIRED = [
    "npm test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "cargo check",
    "cargo clippy",
    "cargo test",
    "cargo fmt --check",
]

READONLY_BASH_ALLOW = [
    "pwd",
    "ls",
    "ls -la",
    "tree",
    "git status",
    "git status --short",
    "git status --porcelain",
    "git diff",
    "git diff --stat",
    "git log -1",
    "git show HEAD",
    "git rev-parse HEAD",
    "git ls-files",
]

SCRIBE_EDIT_DENY = [
    "src/App.tsx",
    "app/page.tsx",
    "components/Button.tsx",
    "scripts/tool.py",
    "tests/example.test.ts",
    "package.json",
    "package-lock.json",
    "agents/architect.md",
    "templates/opencode/agents/architect.role.json",
    ".github/workflows/ci.yml",
    ".env",
    "AGENTS.md",
]

RESTRICTIVE_BROAD_ALLOW_PATTERNS = [
    "tree *",
    "git status *",
    "git diff *",
    "git log *",
    "git show *",
    "npm test *",
    "npm run test *",
    "npm run lint *",
    "npm run build *",
    "npm run typecheck *",
    "npm run verify *",
    "cargo fmt *",
    "cargo clippy *",
    "cargo test *",
]

# Effective bash action for the primary architect: broad allows must not cover dangerous variants.
ARCHITECT_BASH_ACTIONS = [
    ("git status", "allow"),
    ("git diff --stat", "allow"),
    ("git log --oneline -5", "allow"),
    ("git add .", "allow"),
    ("git commit -m test", "allow"),
    ("git branch", "allow"),
    ("git branch --list", "allow"),
    ("git branch --show-current", "allow"),
    ("find . -name '*.ts'", "allow"),
    ("npm test", "allow"),
    ("npm run build", "allow"),
    ("echo hello", "ask"),
    ("echo x > .env.local", "ask"),
    ("echo x >> notes.txt", "ask"),
    ("ls > out.txt", "ask"),
    ("npm test > out.txt", "ask"),
    ("git status > out.txt", "ask"),
    ("find . -delete", "ask"),
    ("find . -exec cat {} ;", "ask"),
    ("find . -execdir sh ;", "ask"),
    ("find . -ok rm {} ;", "ask"),
    ("find . -fprint out.txt", "ask"),
    ("git branch -D feature", "ask"),
    ("git branch -m old new", "ask"),
    ("git branch newbranch", "ask"),
    ("git commit --amend", "ask"),
    ("git commit -m test --amend", "ask"),
    ("git push origin main", "ask"),
    # Branch, history, and working-tree changes beyond add/commit stay ask-gated.
    ("git checkout main", "ask"),
    ("git checkout -b feature", "ask"),
    ("git switch main", "ask"),
    ("git restore .", "ask"),
    ("git pull", "ask"),
    ("git pull origin main", "ask"),
    ("git rebase main", "ask"),
    ("git merge feature", "ask"),
    ("git stash", "ask"),
    ("git stash pop", "ask"),
    ("git tag v1", "ask"),
    # Long-running, installing, networked, and removing commands.
    ("npm run dev", "ask"),
    ("npm run start", "ask"),
    ("npm install", "ask"),
    ("pnpm install", "ask"),
    ("npx vitest", "ask"),
    ("curl https://example.com", "ask"),
    ("wget https://example.com", "ask"),
    ("rm notes.txt", "ask"),
    ("node scripts/build.js", "ask"),
    ("node other.js", "ask"),
    ("cat .env", "deny"),
    ("git push --force-with-lease", "deny"),
    ("git push --force origin main", "deny"),
    ("git push -f", "deny"),
    ("git reset --hard HEAD~1", "deny"),
    ("git clean -fdx", "deny"),
    ("rm -rf node_modules", "deny"),
    ("sudo ls", "deny"),
]

# Top-level permission keys every role must keep gated, and the edit default per role.
# `edit` is a bare action for the read-only roles and a pattern map elsewhere; the map's `*`
# entry is its default.
GATED_TOP_LEVEL_KEYS = ("external_directory", "webfetch", "websearch", "doom_loop")
EDIT_DEFAULT = {
    "architect": "ask",
    "repo-scout": "deny",
    "inspector": "deny",
    "sentinel": "deny",
    "scribe": "deny",
    "verifier": "deny",
}

MUTATION_CASES = [
    ("repo-scout", {"bash": {"*&*": "allow"}}, "bash", "git status & touch changed.txt", "allow"),
    ("verifier", {"bash": {"cargo clippy *": "allow"}}, "bash", "cargo clippy --fix", "allow"),
    ("verifier", {"bash": {"npm run build *": "allow"}}, "bash", "npm run build -- --outDir src", "allow"),
    ("repo-scout", {"bash": {"git diff *": "allow"}}, "bash", "git diff --ext-diff", "allow"),
]


def load_role(name: str) -> dict:
    return json.loads((ROLES_DIR / f"{name}.role.json").read_text(encoding="utf-8"))


def _bash_section(permission: dict) -> dict[str, str]:
    bash = permission.get("bash", {})
    if isinstance(bash, str):
        return {"*": bash}
    if isinstance(bash, dict):
        return bash
    return {}


def _edit_section(permission: dict) -> dict[str, str]:
    edit = permission.get("edit", {})
    if isinstance(edit, str):
        return {"*": edit}
    if isinstance(edit, dict):
        return edit
    return {}


def _validate_restrictive_profile_quality(role: str, perm: dict, errors: list[str]) -> None:
    bash = _bash_section(perm)
    if bash.get("*") != "deny":
        errors.append(f"{role}: restrictive bash profile must default to deny")
    for pattern in RESTRICTIVE_BROAD_ALLOW_PATTERNS:
        if bash.get(pattern) == "allow":
            errors.append(f"{role}: must not allow broad bash pattern {pattern!r}")


def _apply_mutation(perm: dict, mutation: dict) -> dict:
    mutated = copy.deepcopy(perm)
    for key, section in mutation.items():
        if isinstance(section, dict):
            target = mutated.setdefault(key, {})
            if isinstance(target, dict):
                target.update(section)
            else:
                mutated[key] = dict(section)
        else:
            mutated[key] = section
    return mutated


def _architect_bash_errors(perm: dict) -> list[str]:
    errors: list[str] = []
    for cmd, expected in ARCHITECT_BASH_ACTIONS:
        action = effective_bash_action(perm, cmd)
        if action != expected:
            pattern, _ = winning_rule(perm, "bash", cmd)
            errors.append(f"architect: bash {cmd!r} must be {expected}, got {action} (via {pattern!r})")
    return errors


def _top_level_action_errors(role: str, perm: dict) -> list[str]:
    errors: list[str] = []
    for key in GATED_TOP_LEVEL_KEYS:
        if perm.get(key) != "ask":
            errors.append(f"{role}: {key} must be ask, got {perm.get(key)!r}")
    edit = perm.get("edit")
    default = edit.get("*") if isinstance(edit, dict) else edit
    if default != EDIT_DEFAULT[role]:
        errors.append(f"{role}: edit default must be {EDIT_DEFAULT[role]}, got {default!r}")
    return errors


def _secret_read_errors(role: str, perm: dict) -> list[str]:
    errors: list[str] = []
    read = perm.get("read", {})
    if isinstance(read, dict):
        for pat in SECRET_READ + CREDENTIAL_CONFIG_READ:
            if read.get(pat) != "deny":
                errors.append(f"{role}: missing read deny {pat}")
    for path, expected in READ_ACTIONS:
        action = effective_read_action(perm, path)
        if action != expected:
            errors.append(f"{role}: read {path!r} must be {expected}, got {action}")
    return errors


# YAML indicator characters. An unquoted mapping key starting with one of them is
# not a plain key (`*` starts an alias), and OpenCode silently drops the whole
# frontmatter when it fails to parse.
_YAML_KEY_INDICATORS = "*&!|>'\"%@`#,[]{}?:-"
_YAML_VALUE_INDICATORS = "*&!|>%@`"


def _extract_frontmatter(text: str) -> str | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    return None if end == -1 else text[4:end]


def lexical_frontmatter_errors(frontmatter: str) -> list[str]:
    """Strict lexical check for the one-line `key: value` frontmatter these agents use."""
    errors: list[str] = []
    for number, line in enumerate(frontmatter.split("\n"), start=1):
        body = line.lstrip(" ")
        if not body or body.startswith("#"):
            continue
        if body[0] == '"':
            try:
                _, end = json.JSONDecoder().raw_decode(body)
            except ValueError:
                errors.append(f"line {number}: malformed quoted key {body[:40]!r}")
                continue
            if not body[end:].startswith(":"):
                errors.append(f"line {number}: quoted key not followed by ':' {body[:40]!r}")
                continue
            value = body[end + 1 :].strip()
        elif body[0] in _YAML_KEY_INDICATORS:
            errors.append(f"line {number}: unquoted key starts with YAML indicator {body[0]!r}: {body[:40]!r}")
            continue
        elif body.endswith(":"):
            value = ""
        else:
            key, sep, value = body.partition(": ")
            if not sep:
                errors.append(f"line {number}: not a 'key: value' line {body[:40]!r}")
                continue
            value = value.strip()
        if not value:
            continue
        if value[0] in _YAML_VALUE_INDICATORS:
            errors.append(f"line {number}: unquoted value starts with YAML indicator {value[0]!r}: {body[:40]!r}")
        elif value[0] == '"':
            try:
                _, end = json.JSONDecoder().raw_decode(value)
            except ValueError:
                end = -1
            if end != len(value):
                errors.append(f"line {number}: malformed quoted value {body[:40]!r}")
        elif ": " in value or " #" in value:
            errors.append(f"line {number}: unquoted value contains ': ' or ' #' {body[:40]!r}")
    return errors


def validate_agent_frontmatter(role: str, text: str, role_def: dict, expected_permission: dict) -> list[str]:
    """Check the frontmatter is real YAML that parses back to the composed role."""
    frontmatter = _extract_frontmatter(text)
    if frontmatter is None:
        return [f"{role}: generated agent has no YAML frontmatter"]
    lexical = lexical_frontmatter_errors(frontmatter)
    if lexical:
        return [f"{role}: frontmatter is not valid YAML, OpenCode would drop it ({problem})" for problem in lexical]
    try:
        import yaml
    except ImportError:
        return []
    try:
        parsed = yaml.safe_load(frontmatter)
    except yaml.YAMLError as exc:
        return [f"{role}: frontmatter is not valid YAML, OpenCode would drop it ({str(exc).splitlines()[0]})"]
    if not isinstance(parsed, dict):
        return [f"{role}: frontmatter does not parse to a mapping"]
    errors: list[str] = []
    for key in ("name", "description", "mode", "temperature", "steps"):
        if parsed.get(key) != role_def.get(key):
            errors.append(f"{role}: parsed frontmatter {key} differs from role definition")
    if bool(parsed.get("hidden")) != bool(role_def.get("hidden")):
        errors.append(f"{role}: parsed frontmatter hidden differs from role definition")
    # json.dumps keeps dict order, and permission order is semantic (last match wins).
    if json.dumps(parsed.get("permission")) != json.dumps(expected_permission):
        errors.append(f"{role}: parsed frontmatter permission differs (content or order) from composed permission")
    return errors


def validate() -> list[str]:
    errors: list[str] = []

    policy = load_policy()
    for profile_name in ("bash_readonly", "bash_verifier"):
        profile = policy.get("role_profiles", {}).get(profile_name, {})
        if profile.get("default") != "deny":
            errors.append(f"role_profiles.{profile_name}: default must be deny")
        for shell_deny in ("*&*", "*\n*", "*\r*", "*<(*", "*>(*", "*< *", "tree -*"):
            if shell_deny not in profile.get("deny", []):
                errors.append(f"role_profiles.{profile_name}: missing deny {shell_deny!r}")

    for role in READONLY_ROLES:
        perm = compose_role_permission(load_role(role))
        if perm.get("edit") != "deny":
            errors.append(f"{role}: edit must be deny")
        if perm.get("task") != "deny":
            errors.append(f"{role}: task must be deny")
        _validate_restrictive_profile_quality(role, perm, errors)
        for cmd in READONLY_BASH_DENY:
            if bash_is_allowed(perm, cmd):
                pattern, action = winning_rule(perm, "bash", cmd)
                errors.append(f"{role}: must not allow bash {cmd!r} (matched {pattern!r} -> {action})")
        for cmd in READONLY_BASH_ALLOW:
            if not bash_is_allowed(perm, cmd):
                pattern, action = winning_rule(perm, "bash", cmd)
                errors.append(f"{role}: must allow bash {cmd!r} (effective {action} via {pattern!r})")

    verifier = compose_role_permission(load_role("verifier"))
    if verifier.get("edit") != "deny":
        errors.append("verifier: edit must be deny")
    _validate_restrictive_profile_quality("verifier", verifier, errors)
    for cmd in VERIFIER_REQUIRED:
        if not bash_is_allowed(verifier, cmd):
            pattern, action = winning_rule(verifier, "bash", cmd)
            errors.append(f"verifier: must allow bash {cmd!r} (effective {action} via {pattern!r})")
    for cmd in VERIFIER_FORBIDDEN:
        if bash_is_allowed(verifier, cmd):
            pattern, action = winning_rule(verifier, "bash", cmd)
            errors.append(f"verifier: must not allow bash {cmd!r} (matched {pattern!r} -> {action})")

    scribe = compose_role_permission(load_role("scribe"))
    if not edit_is_allowed(scribe, "README.md") or not edit_is_allowed(scribe, "docs/guide.md"):
        errors.append("scribe: documentation paths must be editable")
    for path in SCRIBE_EDIT_DENY:
        if edit_is_allowed(scribe, path):
            pattern, action = winning_rule(scribe, "edit", path)
            errors.append(f"scribe: must not allow edit {path!r} (matched {pattern!r} -> {action})")
    _validate_restrictive_profile_quality("scribe", scribe, errors)
    for cmd in READONLY_BASH_DENY:
        if bash_is_allowed(scribe, cmd):
            pattern, action = winning_rule(scribe, "bash", cmd)
            errors.append(f"scribe: must not allow bash {cmd!r} (matched {pattern!r} -> {action})")

    architect = compose_role_permission(load_role("architect"))
    if not edit_is_allowed(architect, "src/App.tsx"):
        errors.append("architect: must allow source edit")
    if not bash_is_allowed(architect, "git commit -m test"):
        errors.append("architect: must allow git commit")
    task = architect.get("task", {})
    if not isinstance(task, dict) or task.get("repo-scout") != "allow":
        errors.append("architect: must allow repo-scout delegation")
    if architect.get("question") != "allow":
        errors.append("architect: must allow the question tool (body asks when a choice is material)")
    errors.extend(_architect_bash_errors(architect))

    for role in ALL_ROLES:
        perm = compose_role_permission(load_role(role))
        errors.extend(_top_level_action_errors(role, perm))
        errors.extend(_secret_read_errors(role, perm))
        bash = perm.get("bash", {})
        if isinstance(bash, dict):
            for pat in DESTRUCTIVE_BASH:
                if bash.get(pat) != "deny":
                    errors.append(f"{role}: missing bash deny {pat}")
        edit = perm.get("edit", {})
        if isinstance(edit, dict):
            for pat in SECRET_READ:
                if edit.get(pat) != "deny":
                    errors.append(f"{role}: missing edit deny {pat}")

    for role in ALL_ROLES:
        agent_path = AGENTS_DIR / f"{role}.md"
        role_path = ROLES_DIR / f"{role}.role.json"
        if not agent_path.is_file():
            errors.append(f"missing generated OpenCode agent: {agent_path.name}")
            continue
        expected_header = compose_opencode_header(role_path)
        actual = agent_path.read_text(encoding="utf-8")
        if not actual.startswith(f"---\n{expected_header}---"):
            errors.append(f"{role}: generated adapter drift (run generate-agent-adapters.py --write)")
        errors.extend(
            validate_agent_frontmatter(
                role, actual, load_role(role), compose_role_permission(load_role(role))
            )
        )

    baseline = {role: compose_role_permission(load_role(role)) for role in RESTRICTIVE_ROLES}
    for role, mutation, perm_key, pattern, expected_action in MUTATION_CASES:
        base = baseline.get(role) or compose_role_permission(load_role(role))
        mutated = _apply_mutation(base, mutation)
        if perm_key == "bash":
            actual = effective_bash_action(mutated, pattern)
        else:
            actual = effective_edit_action(mutated, pattern) if perm_key == "edit" else "ask"
        if actual != expected_action:
            errors.append(
                f"mutation sanity: widening {role} should yield {expected_action} for {pattern!r}, got {actual}"
            )

    scribe_base = compose_role_permission(load_role("scribe"))
    scribe_mut = _apply_mutation(scribe_base, {"edit": {"agents/**": "allow"}})
    if not edit_is_allowed(scribe_mut, "agents/architect.md"):
        errors.append("mutation sanity: scribe agents/** allow should permit agents/architect.md")

    # Removing a credential read deny must be reported by the contract check itself.
    repo_scout_base = compose_role_permission(load_role("repo-scout"))
    for pattern in SECRET_READ + CREDENTIAL_CONFIG_READ:
        repo_scout_mut = copy.deepcopy(repo_scout_base)
        read = repo_scout_mut.get("read")
        if isinstance(read, dict):
            read.pop(pattern, None)
        if not any(pattern in err for err in _secret_read_errors("repo-scout", repo_scout_mut)):
            errors.append(f"mutation sanity: removing read deny {pattern} was not detected")

    return errors


def main() -> None:
    errors = validate()
    if errors:
        print("FAIL: OpenCode permission contract validation failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)
    print(f"PASS: OpenCode permission contract valid for {len(ALL_ROLES)} roles")


if __name__ == "__main__":
    main()
