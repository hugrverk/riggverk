#!/usr/bin/env python3
"""Mirror OpenCode 1.19.3 permission evaluation.

Source read: anomalyco/opencode tag v1.19.3 (commit e3c4eb242585dcd77be1a867391b7c25fd47ce52),
which parses shell with tree-sitter-bash 0.25.0 (tag v0.25.0, commit 56b54c61fb48). Three layers
are modelled, each also checked against the installed OpenCode with
`opencode debug agent <name> --pure` (see the validator and OPENCODE_CONFIG.md):

* the matcher: `Wildcard.match` plus `findLast` over a flattened ruleset
  (packages/core/src/util/wildcard.ts, `evaluate` in packages/opencode/src/permission/index.ts);
* the tools: `read`/`edit`/`write` ask with `path.relative(worktree, file)` (tool/read.ts,
  tool/edit.ts), and `bash` asks once with one pattern per tree-sitter `command` node
  (`commands`, `source` and `collect` in packages/opencode/src/tool/shell.ts). `Permission.ask`
  throws on the first denied pattern and prompts when any pattern is not allowed, so a compound
  command is evaluated part by part and the strictest result wins (deny, then ask, then allow);
* the agents: a built-in agent is `defaults + built-in restriction + user config`, and the
  config `agent.<name>.permission` is appended last (packages/opencode/src/agent/agent.ts).

Not modelled: the extra `external_directory` ask that the shell tool adds for file commands
(`rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `cat`, ...) whose path argument lies outside
the worktree. With this policy that rule asks or allows, so it can turn a modelled allow into
ask, never into deny.
"""

from __future__ import annotations

import functools
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Iterable

Action = str  # allow | deny | ask


@dataclass(frozen=True)
class Rule:
    permission: str
    pattern: str
    action: Action


def wildcard_match(value: str, pattern: str) -> bool:
    """Match OpenCode Wildcard.match (packages/core/src/util/wildcard.ts)."""
    if value:
        value = value.replace("\\", "/")
    return _wildcard_regex(pattern, _is_windows()).fullmatch(value) is not None


@functools.lru_cache(maxsize=None)
def _wildcard_regex(pattern: str, windows: bool) -> re.Pattern[str]:
    if pattern:
        pattern = pattern.replace("\\", "/")
    escaped = re.sub(r"[.+^${}()|[\]\\]", r"\\\g<0>", pattern)
    escaped = escaped.replace("*", ".*").replace("?", ".")
    if escaped.endswith(" .*"):
        escaped = escaped[:-3] + "( .*)?"
    # Upstream compiles with the "s" flag (dot matches newline), plus "i" on win32.
    return re.compile(escaped, re.DOTALL | (re.IGNORECASE if windows else 0))


def _is_windows() -> bool:
    return sys.platform == "win32"


def expand_home(pattern: str) -> str:
    if pattern.startswith("~/"):
        return os.path.expanduser("~") + pattern[1:]
    if pattern == "~":
        return os.path.expanduser("~")
    if pattern.startswith("$HOME/"):
        return os.path.expanduser("~") + pattern[5:]
    if pattern.startswith("$HOME"):
        return os.path.expanduser("~") + pattern[5:]
    return pattern


def ruleset_from_section(permission_key: str, section: Any) -> list[Rule]:
    rules: list[Rule] = []
    if isinstance(section, str):
        rules.append(Rule(permission_key, "*", section))
        return rules
    if not isinstance(section, dict):
        return rules
    for pattern, action in section.items():
        rules.append(Rule(permission_key, expand_home(pattern), action))
    return rules


def ruleset_from_permission(permission: dict[str, Any]) -> list[Rule]:
    rules: list[Rule] = []
    for key, value in permission.items():
        rules.extend(ruleset_from_section(key, value))
    return rules


def evaluate(permission: str, pattern: str, *rulesets: Iterable[Rule]) -> Rule:
    merged = [rule for ruleset in rulesets for rule in ruleset]
    # wildcard_match inlined: the values are normalized once, not once per rule.
    windows = _is_windows()
    permission_value = permission.replace("\\", "/")
    pattern_value = pattern.replace("\\", "/")
    for rule in reversed(merged):
        if (
            _wildcard_regex(rule.permission, windows).fullmatch(permission_value) is not None
            and _wildcard_regex(rule.pattern, windows).fullmatch(pattern_value) is not None
        ):
            return rule
    return Rule(permission, "*", "ask")


# --- bash: one pattern per tree-sitter `command` node -------------------------------------------

# Commands OpenCode never asks `bash` about (it only checks the paths they touch).
_CWD_COMMANDS = {"cd", "chdir", "popd", "pushd", "push-location", "set-location"}
# tree-sitter-bash parses these as declaration/unset/test nodes, not `command` nodes, so they are never
# matched (`declaration_command`, `unset_command` and `test_command` in its grammar.js).
_DECLARATIONS = {"export", "declare", "typeset", "readonly", "local", "unset", "unsetenv", "["}
# Words that open or close a compound statement and are not themselves commands.
_LEADING_KEYWORDS = ("!", "if", "then", "else", "elif", "do", "while", "until", "{")
_NON_COMMAND_WORDS = {"fi", "done", "esac", "}", "for", "select", "case", ")"} | _DECLARATIONS
_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=")
_HEREDOC = re.compile(r"<<(-?)[ \t]*(?:'([^']*)'|\"([^\"]*)\"|\\?([A-Za-z0-9_.-]+))")
_FUNCTION_HEADER = re.compile(r"(?:function\s+)?[A-Za-z_][\w.-]*\s*(?:\(\s*\))?\s*\{\s*")
# A redirect that ends a command: `> f`, `>> f`, `2>&1`, `&> f`, `< f`, `<<EOF`.
_TRAILING_REDIRECT = re.compile(
    r"""\s+(?:(?:\d+|&)?(?:>>|>\||>&|>|<&|<)\s*(?:'[^']*'|"[^"]*"|\S+)|<<-?[ \t]*(?:'[^']*'|"[^"]*"|\\?[A-Za-z0-9_.-]+))\s*$"""
)


def _skip_word(text: str, i: int) -> int:
    """Index just past the shell word starting at text[i] (quotes respected)."""
    n = len(text)
    while i < n and not text[i].isspace():
        if text[i] in "<>|&;()":
            break
        if text[i] == "\\":
            i += 2
            continue
        if text[i] in "'\"":
            quote = text[i]
            i += 1
            while i < n and text[i] != quote:
                i += 2 if quote == '"' and text[i] == "\\" else 1
        i += 1
    return min(i, n)


def _command_name(text: str) -> str | None:
    """First word of a command after leading VAR=value assignments, or None when there is none."""
    i = 0
    n = len(text)
    while True:
        while i < n and text[i].isspace():
            i += 1
        match = _ASSIGNMENT.match(text, i)
        if not match:
            break
        i = _skip_word(text, match.end())
    if i >= n:
        return None
    end = _skip_word(text, i)
    return text[i:end] or None


def _strip_leading_keywords(text: str) -> str:
    while True:
        for keyword in _LEADING_KEYWORDS:
            if text == keyword or (text.startswith(keyword) and text[len(keyword)].isspace()):
                text = text[len(keyword) :].lstrip()
                break
        else:
            return text


def _skip_parens(text: str, i: int) -> int:
    """Index past the `)` that closes the `(` group whose opening `(` sits just before text[i]."""
    depth = 1
    n = len(text)
    while i < n and depth:
        if text[i] == "\\":
            i += 1
        elif text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
        i += 1
    return i


@dataclass
class _Command:
    text: str
    start: int  # offset of the command in the whole source, for heredoc spans
    chain: int  # 0 for the first command of a `|`/`&&`/`||` chain, which keeps its redirect


class _Scanner:
    """Collect the text of every `command` node the way OpenCode's shell tool does."""

    def __init__(self, source: str) -> None:
        self.source = source
        self.commands: list[_Command] = []
        # (delimiter, strip_tabs, quoted, command that owns the heredoc) waiting for the next newline
        self.pending: list[tuple[str, bool, bool, _Command]] = []

    def flush(
        self, chars: list[str], start: int | None, chain: int, heredocs: list[tuple[str, bool, bool]]
    ) -> None:
        raw = "".join(chars).strip()
        chars.clear()
        text = _strip_leading_keywords(raw)
        offset = (start or 0) + len(raw) - len(text)
        header = _FUNCTION_HEADER.match(text)
        if header and not text.startswith("{"):
            text = text[header.end() :]
            offset += header.end()
        if chain:
            # A redirect after the first command of a chain belongs to the whole chain, not to the command.
            while True:
                stripped = _TRAILING_REDIRECT.sub("", text, count=1)
                if stripped == text:
                    break
                text = stripped
        name = _command_name(text) if text else None
        if name is None or name in _NON_COMMAND_WORDS or name in _CWD_COMMANDS:
            return
        command = _Command(text, offset, chain)
        self.commands.append(command)
        self.pending.extend((delimiter, strip_tabs, quoted, command) for delimiter, strip_tabs, quoted in heredocs)

    def double_quoted(self, i: int, chars: list[str]) -> int:
        """Consume "..." starting at source[i]; command substitutions inside it are still parsed."""
        text = self.source
        start = i
        i += 1
        n = len(text)
        while i < n and text[i] != '"':
            if text[i] == "\\":
                i += 2
            elif text.startswith("$((", i):
                i = _skip_parens(text, i + 2)
            elif text.startswith("$(", i):
                i = self.scan(i + 2, ")")
            elif text[i] == "`":
                i = self.scan(i + 1, "`")
            else:
                i += 1
        i = min(i + 1, n)
        chars.append(text[start:i])
        return i

    def heredoc_bodies(self, i: int) -> int:
        """Skip the bodies of pending heredocs starting at source[i]; a command spans through its heredoc."""
        text = self.source
        n = len(text)
        for delimiter, strip_tabs, quoted, command in self.pending:
            body_start = i
            end = i
            for line in text[i:].split("\n"):
                end = min(end + len(line), n)
                if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                    break
                end = min(end + 1, n)
            if command.chain == 0:
                command.text = text[command.start : end].strip()
            if not quoted:
                self.body_substitutions(body_start, end)
            i = min(end + 1, n)
        self.pending.clear()
        return i

    def body_substitutions(self, i: int, end: int) -> None:
        """An unquoted heredoc body still runs `$( )`; tree-sitter reports those commands too."""
        text = self.source
        while i < end:
            if text[i] == "\\":
                i += 2
            elif text.startswith("$((", i):
                i = _skip_parens(text, i + 2)
            elif text.startswith("$(", i):
                i = self.scan(i + 2, ")")
            else:
                i += 1

    def scan(self, i: int, closer: str | None) -> int:
        """Collect commands from source[i:] up to `closer` (")" or "`") or the end; return the next index."""
        text = self.source
        n = len(text)
        chars: list[str] = []
        start: int | None = None
        chain = 0
        heredocs: list[tuple[str, bool, bool]] = []

        def add(piece: str, at: int) -> None:
            nonlocal start
            if start is None and not piece.isspace():
                start = at
            chars.append(piece)

        def end_command(next_chain: int) -> None:
            nonlocal start, chain, heredocs
            self.flush(chars, start, chain, heredocs)
            start = None
            heredocs = []
            chain = next_chain

        while i < n:
            c = text[i]
            if closer is not None and c == closer:
                end_command(0)
                return i + 1
            at_start = not "".join(chars).strip()
            if c == "\\" and text.startswith("\\\n", i) and at_start:
                i += 2  # a line continuation before a command is just whitespace
            elif c == "\\":
                add(text[i : i + 2], i)
                i += 2
            elif c == "'":
                end = text.find("'", i + 1)
                end = n - 1 if end < 0 else end
                add(text[i : end + 1], i)
                i = end + 1
            elif c == '"':
                piece_start = i
                piece: list[str] = []
                i = self.double_quoted(i, piece)
                add("".join(piece), piece_start)
            elif text.startswith("$((", i):
                end = _skip_parens(text, i + 2)
                add(text[i:end], i)
                i = end
            elif text.startswith("$(", i) or (c in "<>" and text.startswith("(", i + 1)):
                piece_start = i
                i = self.scan(i + 2, ")")
                add(text[piece_start:i], piece_start)
            elif c == "`":
                piece_start = i
                i = self.scan(i + 1, "`")
                add(text[piece_start:i], piece_start)
            elif c == "(" and at_start:
                # A subshell or `((...))`: not a command itself, its contents are.
                if text.startswith("((", i):
                    i = _skip_parens(text, i + 1)
                else:
                    i = self.scan(i + 1, ")")
            elif c == "[" and at_start and text.startswith("[[", i):
                end = text.find("]]", i + 2)
                i = n if end < 0 else end + 2
            elif c == "#" and (not chars or chars[-1][-1:].isspace()):
                while i < n and text[i] != "\n":
                    i += 1
            elif c == "\n":
                end_command(0)
                i = self.heredoc_bodies(i + 1)
            elif c == ";":
                end_command(0)
                i += 1
            elif c == "&":
                previous = text[i - 1] if i else ""
                following = text[i + 1] if i + 1 < n else ""
                if previous in "<>" or following == ">":  # >&  <&  &>  &>>
                    add(c, i)
                    i += 1
                elif following == "&":
                    end_command(chain + 1)
                    i += 2
                else:
                    end_command(0)
                    i += 1
            elif c == "|":
                previous = text[i - 1] if i else ""
                following = text[i + 1] if i + 1 < n else ""
                if previous == ">":  # >|
                    add(c, i)
                    i += 1
                else:
                    end_command(chain + 1)
                    i += 2 if following in "|&" else 1
            elif c == "<" and text.startswith("<<", i) and not text.startswith("<<<", i):
                match = _HEREDOC.match(text, i)
                if match:
                    quoted = match.group(4) is None or "\\" in match.group(0)
                    heredocs.append((match.group(2) or match.group(3) or match.group(4), match.group(1) == "-", quoted))
                    add(match.group(0), i)
                    i = match.end()
                else:
                    add("<<", i)
                    i += 2
            else:
                add(c, i)
                i += 1
        end_command(0)
        return i


def shell_command_patterns(command: str) -> list[str]:
    """Patterns OpenCode 1.19.3 asks `bash` about for one tool call.

    It parses the command with tree-sitter-bash and asks once per `command` node, in any
    nesting (`node.descendantsOfType("command")`), with the node's own source text, or the text
    of its parent when that parent is a `redirected_statement` (`source()` in tool/shell.ts).
    There is no operator splitting as such: pipes, `&&`, `||`, `;`, `&`, newlines, subshells
    and the contents of `$( )`, backticks and `<( )` become separate patterns because each holds
    its own `command` nodes, while the outer command keeps the substitution text. Verified against
    1.19.3 with scratchpad probes of 90 shapes (see OPENCODE_CONFIG.md):

    * a redirect stays in the pattern of the first command of a chain (`a > f && b`), but a
      redirect after a later `|`, `&&` or `||` element is not part of any pattern (`a && b > f`
      is evaluated as `a`, `b`), so a redirect can hide behind a second allowed command. In the
      grammar the body of a `redirected_statement` is any statement, `list` and `pipeline`
      included, so the redirect wraps the whole chain and no `command` node has it as parent;
    * a command with a heredoc spans through the end of the heredoc body;
    * `cd` (and the other `CWD` commands), `export`/`declare`/`typeset`/`readonly`/`local`,
      `unset`/`unsetenv` and `[ ... ]`/`[[ ... ]]` are skipped;
    * variable assignments alone produce no pattern.

    This is a scanner for those shapes, not a full bash grammar: `case` arms and heredoc bodies
    with substitutions are not modelled.
    """
    scanner = _Scanner(command)
    scanner.scan(0, None)
    return [item.text for item in scanner.commands]



def strictest(actions: Iterable[Action]) -> Action:
    """deny if any part is denied, else ask if any part asks, else allow (Permission.ask)."""
    actions = list(actions)
    if "deny" in actions:
        return "deny"
    if any(action != "allow" for action in actions):
        return "ask"
    return "allow"


def bash_action_for_parts(rules: list[Rule], command: str) -> Action:
    """Action for one bash call: the strictest over its command patterns."""
    return strictest(evaluate("bash", pattern, rules).action for pattern in shell_command_patterns(command))


def explain_bash(permission: dict[str, Any], command: str) -> str:
    """Per-part verdicts, for validator messages."""
    bash = permission.get("bash")
    if isinstance(bash, str):
        return f"bash is the bare action {bash}"
    rules = ruleset_from_section("bash", bash) if bash is not None else []
    parts = [
        f"{pattern!r} -> {evaluate('bash', pattern, rules).action} via {evaluate('bash', pattern, rules).pattern!r}"
        for pattern in shell_command_patterns(command)
    ]
    return "; ".join(parts) or "no command part"


def effective_bash_action(permission: dict[str, Any], command: str) -> Action:
    bash = permission.get("bash")
    if isinstance(bash, str):
        return bash
    rules = ruleset_from_section("bash", bash) if bash is not None else []
    return bash_action_for_parts(rules, command)


# --- read / edit: the worktree-relative path ------------------------------------------------------


def worktree_relative(path: str, worktree: str) -> str:
    """The pattern read/edit/write ask with: path.relative(worktree, file)."""
    return os.path.relpath(path, worktree).replace(os.sep, "/")


def effective_edit_action(permission: dict[str, Any], path: str) -> Action:
    """`path` is worktree-relative, like OpenCode's `edit` ask pattern."""
    edit = permission.get("edit")
    if isinstance(edit, str):
        return edit
    rules = ruleset_from_section("edit", edit) if edit is not None else []
    return evaluate("edit", path, rules).action


def effective_read_action(permission: dict[str, Any], path: str) -> Action:
    """`path` is worktree-relative, like OpenCode's `read` ask pattern."""
    read = permission.get("read")
    if isinstance(read, str):
        return read
    rules = ruleset_from_section("read", read) if read is not None else []
    return evaluate("read", path, rules).action


def bash_is_allowed(permission: dict[str, Any], command: str) -> bool:
    return effective_bash_action(permission, command) == "allow"


def bash_is_denied(permission: dict[str, Any], command: str) -> bool:
    return effective_bash_action(permission, command) == "deny"


def edit_is_allowed(permission: dict[str, Any], path: str) -> bool:
    return effective_edit_action(permission, path) == "allow"


def matching_rules(permission: dict[str, Any], perm_key: str, pattern: str) -> list[tuple[str, Action]]:
    section = permission.get(perm_key)
    if isinstance(section, str):
        return [("*", section)] if wildcard_match(perm_key, perm_key) else []
    if not isinstance(section, dict):
        return []
    rules = ruleset_from_section(perm_key, section)
    matched: list[tuple[str, Action]] = []
    for rule in rules:
        if wildcard_match(perm_key, rule.permission) and wildcard_match(pattern, rule.pattern):
            matched.append((rule.pattern, rule.action))
    return matched


def winning_rule(permission: dict[str, Any], perm_key: str, pattern: str) -> tuple[str, Action]:
    section = permission.get(perm_key)
    if isinstance(section, str):
        return ("*", section)
    rules = ruleset_from_section(perm_key, section) if isinstance(section, dict) else []
    rule = evaluate(perm_key, pattern, rules)
    return (rule.pattern, rule.action)


# --- agents: defaults + built-in restriction + user config + agent override -----------------------

# Tools that share a permission key with their family: write/apply_patch ask `edit`.
EDIT_TOOLS = ("edit", "write", "apply_patch")

# Where the plan agent may write plan files, relative to the worktree, as agent.ts builds it:
# `.opencode/plans/*.md` and path.relative(worktree, <data dir>/plans/*.md).
DEFAULT_PLAN_DATA_PATTERN = "../.local/share/opencode/plans/*.md"


def opencode_default_rules(whitelisted_dirs: Iterable[str] = ()) -> list[Rule]:
    """The `defaults` ruleset of every built-in agent (agent.ts, v1.19.3)."""
    external: dict[str, str] = {"*": "ask"}
    external.update({f"{directory}/*": "allow" for directory in whitelisted_dirs})
    return ruleset_from_permission(
        {
            "*": "allow",
            "doom_loop": "ask",
            "external_directory": external,
            "question": "deny",
            "plan_enter": "deny",
            "plan_exit": "deny",
            "read": {"*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow"},
        }
    )


def builtin_restriction(agent: str, plan_data_pattern: str = DEFAULT_PLAN_DATA_PATTERN) -> list[Rule]:
    """The agent-specific part of a built-in agent's ruleset, before the user config."""
    restrictions: dict[str, dict[str, Any]] = {
        "build": {"question": "allow", "plan_enter": "allow"},
        "plan": {
            "question": "allow",
            "plan_exit": "allow",
            "task": {"general": "deny"},
            "edit": {"*": "deny", ".opencode/plans/*.md": "allow", plan_data_pattern: "allow"},
        },
        "general": {"todowrite": "deny"},
        "explore": {
            "*": "deny",
            "grep": "allow",
            "glob": "allow",
            "list": "allow",
            "bash": "allow",
            "webfetch": "allow",
            "websearch": "allow",
            "read": "allow",
        },
        "compaction": {"*": "deny"},
        "title": {"*": "deny"},
        "summary": {"*": "deny"},
    }
    return ruleset_from_permission(restrictions[agent])


def compose_agent_rules(
    agent: str,
    user_permission: dict[str, Any],
    agent_permission: dict[str, Any] | None = None,
    *,
    whitelisted_dirs: Iterable[str] = (),
    plan_data_pattern: str = DEFAULT_PLAN_DATA_PATTERN,
) -> list[Rule]:
    """Ruleset OpenCode evaluates for a built-in agent.

    `user_permission` is the merged config `permission`; `agent_permission` is the config's
    `agent.<name>.permission`, which OpenCode appends after the user ruleset. A custom agent
    (not built in) is `defaults + user + its own permission`.
    """
    defaults = opencode_default_rules(whitelisted_dirs)
    try:
        restriction = builtin_restriction(agent, plan_data_pattern)
    except KeyError:
        restriction = []
    rules = defaults + restriction + ruleset_from_permission(user_permission)
    if agent_permission:
        rules += ruleset_from_permission(agent_permission)
    return rules


def action_for(rules: list[Rule], permission: str, pattern: str) -> Action:
    return evaluate(permission, pattern, rules).action


def tool_hidden(rules: list[Rule], tool: str) -> bool:
    """Permission.disabled: a tool is removed when its last matching rule is a bare `*` deny."""
    permission = "edit" if tool in EDIT_TOOLS else tool
    last = next((rule for rule in reversed(rules) if wildcard_match(permission, rule.permission)), None)
    return last is not None and last.pattern == "*" and last.action == "deny"
