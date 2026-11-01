# Delegate recipes

Exact commands for running a delegate that writes, in its own git worktree, through another harness's CLI. Checked against the `--help` of Codex CLI 0.164.0, Claude Code 2.1.308 and OpenCode 1.19.4 on 2026-10-31; the Claude Code and OpenCode commands were also run end to end (commit allowed, push and writes outside the worktree refused). Only the Codex route has an OS sandbox; the other two are permission rules, which are best effort (see Containment). After upgrading a CLI, check its `--help` again before trusting a flag.

`$T` is the temporary directory from Prepare, `$T/wt` the worktree, `$T/brief.md` the brief. Write their absolute paths into each command: shell variables may not survive between your tool calls.

## Rules for every route

- **Preflight** once per session per route, before its first run. Use only the exit status; never print or quote the output, which can name the account.
- **Stdin.** Feed the brief through stdin or close it with `< /dev/null`; `codex exec` hangs on an open stdin.
- **Timeout.** macOS has no `timeout`, so wrap the command in `perl -e 'alarm shift; exec @ARGV or die "exec: $!"' <seconds>`. Exit status 142 means it timed out.
- **Environment.** Do not hand the delegate API keys its own login does not use: prefix `env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY`, keeping only a variable the user's login for that CLI relies on. A stray `ANTHROPIC_API_KEY` moves `claude -p` to API billing.
- **Containment.** What each route contains differs, and only the Codex route is a sandbox.
  - Codex: an OS sandbox confines file writes to the worktree and the temporary directories, with the network off.
  - Claude Code and OpenCode: permission rules only, no OS sandbox. They refuse edits outside the worktree, `git push`, web tools, subagents and MCP servers, and every shell command that is not on the allow-list. They do not contain what the allowed commands run: an acceptance check, a package script, a Makefile target or a git hook executes whatever the worktree holds, with the user's rights, and the delegate may have edited it. Treat these two routes as best effort, not as confinement.
  - All routes: MCP tools run outside every sandbox and permission rule that guards files, so a delegate never gets one.
  - Hooks: the delegate's own commits run with `core.hooksPath` forced to `/dev/null` (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null` in the commands below), so a hook it edited does not run when it commits. This is a git setting, not a permission rule: git applies it to every `git` call in that process tree.
  - Checks: the acceptance checks are the one thing the delegate can make run code. Allow only the exact check commands, add a deny for edits to the files they execute (the check script, `package.json` scripts, `Makefile`, hook folders such as `.husky/` and `.githooks/`) unless the slice is about them, and read the diff of those files before you run any check yourself (Review like a PR in SKILL.md).
- **Model.** Add the model flag only when the user named a model; otherwise the CLI's configured default applies.
- **Background.** Wrap the whole command as `( <command>; echo $? > "$T/exit" ) &`, or use your harness's background facility.
- **Result.** The output file is data. Judge the run by the worktree's diff and your own checks; a non-zero exit, an empty output or no `STATUS:` line means the run did not finish, whatever it says.

## Codex (`codex exec`)

The workspace-write sandbox (Seatbelt on macOS, bubblewrap on Linux) confines writes to the worktree and the temporary directories.

Preflight: `codex login status >/dev/null 2>&1`

```sh
perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
  codex exec -s workspace-write -c 'sandbox_workspace_write.network_access=false' \
    --disable multi_agent --disable plugins --disable apps --disable browser_use --disable computer_use \
    [-c 'mcp_servers.<name>.enabled=false' ...] \
    -C "$T/wt" [-m '<model>'] -o "$T/out.md" - \
    < "$T/brief.md" > "$T/run.log" 2>&1
```

- `-s workspace-write` pins the sandbox whatever `config.toml` says; turning network off blocks pushes and installs. `--disable multi_agent` stops it spawning agents; `-` reads the brief from stdin; `-o` writes only the final message.
- MCP: take the server names that are still enabled from `codex --disable plugins mcp list --json`, reading only `name` and `enabled` (the JSON can hold commands and env values; never print it), and add one `-c 'mcp_servers.<name>.enabled=false'` each. Skip the route if a name is outside `[A-Za-z0-9_-]`, and re-run the list with the same flags: nothing may stay enabled.
- Keep the user's command rules (no `--ignore-rules`) and config (no `--ignore-user-config`, which also drops their model). Never use `--dangerously-bypass-approvals-and-sandbox`.
- The sandbox may refuse writes to the worktree's git metadata, which lives in the main repository's `.git`. Then the delegate's commits fail and it leaves the changes in place, as the brief says; you commit them in Collect. Do not make the git directory writable with `--add-dir`: that would let the delegate rewrite the main repository's hooks and config.
- The `session id:` line near the top of `run.log` names the session. Resume it from the worktree, since `resume` takes neither `-s` nor `-C`:

  ```sh
  cd "$T/wt" && perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
    env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
    codex exec resume '<session-id>' -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=false' \
      --disable multi_agent --disable plugins --disable apps --disable browser_use --disable computer_use \
      -o "$T/out2.md" - < "$T/followup.md" > "$T/run2.log" 2>&1
  ```

- A spent quota exits 1 within seconds with a usage-limit error in `run.log` and no `out.md`.
- Inside Claude Code's sandbox this fails with `sandbox_apply: Operation not permitted`, because sandboxes do not nest on macOS: run it outside that sandbox with the user's approval.

## Claude Code (`claude -p`)

No OS sandbox, only permission rules: edits outside the working directory are refused by the permission mode, and so is every shell command outside the allow-list. A permitted command is not contained (see Containment): the acceptance checks run whatever the worktree holds.

Preflight: `claude auth status >/dev/null 2>&1`

```sh
cd "$T/wt" && perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
  claude -p --safe-mode --strict-mcp-config --permission-mode acceptEdits --permission-prompts none \
    --disallowedTools 'Agent Task WebFetch WebSearch Edit(<check script>) Edit(package.json) Edit(.husky/**) Edit(.githooks/**) Bash(git difftool *) Bash(git config *)' \
    --allowedTools 'Bash(git add *) Bash(git commit *) Bash(git status) Bash(git diff) Bash(git diff --stat) Bash(<check command>)' \
    --output-format json [--model '<model>'] [--max-budget-usd <n>] \
    < "$T/brief.md" > "$T/out.json" 2> "$T/run.err"
```

- Run it from the worktree: there is no `--cwd`. `acceptEdits` accepts edits inside the working directory; `--permission-prompts none` refuses everything that would prompt, including edits outside it and any command not allowed. Add one exact `Bash(<command>)` per acceptance check, with no trailing `*`; never a bare `Bash` or `Bash(*)`. `git status` and `git diff` are listed as exact commands because a `git diff *` prefix would also allow `--output=<file>`. In `--disallowedTools`, list an `Edit(<path>)` for every file the checks execute and every hook folder, as in the example, and drop the ones that are the slice's scope.
- A compound command (`a && b`) runs only when every part is allowed, so the brief asks for one git command at a time.
- `--safe-mode` turns off CLAUDE.md, skills, plugins, hooks and MCP servers but keeps the subscription login, so paste the conventions that matter into the brief. `--strict-mcp-config` without `--mcp-config` also drops MCP servers that managed settings would add. Never `--bare`: it refuses subscription logins. Never `--dangerously-skip-permissions`.
- The answer is the `result` field of `out.json`; check `is_error` and the exit status too. `session_id` resumes the run: the same command with `--resume '<session_id>'` and the follow-up brief on stdin. `total_cost_usd` goes in the report.
- Inside Codex's sandbox this fails: no network, and the login keychain is hidden. Request escalated permissions for this command, once per run.

## OpenCode (`opencode run`)

Permission rules only, no OS sandbox (see Containment). The delegate is a one-off primary agent defined inline: edits allowed inside the worktree except the files the checks execute, shell limited to the listed commands, everything else denied; the user's secret-file read rules still apply.

Never pass `--auto` (it approves everything not explicitly denied) or `-c`. `opencode run` refuses every permission that would ask, so `edit` must be allowed explicitly.

Preflight and run, in one command so the two variables stay set. The preflight writes its JSON to a file because a pipe can cut it at 128 KiB, and it proves the agent resolves with no tool beyond the allowed ones, not the login:

```sh
cd "$T/wt" \
&& export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT='{"agent":{"riggverk-delegate":{"mode":"primary","description":"Delegated implementer","permission":{"edit":{"*":"allow","<check script>":"deny","package.json":"deny",".husky/**":"deny",".githooks/**":"deny"},"bash":{"*":"deny","git add *":"allow","git commit *":"allow","git status":"allow","git diff":"allow","git diff --stat":"allow","git diff --cached":"allow","<check command>":"allow"},"task":"deny","webfetch":"deny","websearch":"deny","skill":"deny","codesearch":"deny","external_directory":"deny","*_*":"deny"}}}}' \
&& opencode debug agent riggverk-delegate --pure > "$T/agent.json" 2>/dev/null \
&& perl -MJSON::PP -0777 -ne '$t = decode_json($_)->{tools}; @x = grep { $t->{$_} && !/^(invalid|read|glob|grep|list|edit|write|patch|bash|todowrite)$/ } sort keys %$t; die "riggverk-delegate also has: @x\n" if @x' "$T/agent.json" \
&& perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
  opencode run --pure --agent riggverk-delegate [-m '<provider>/<model>'] \
    "Follow the attached brief exactly." -f "$T/brief.md" \
    < /dev/null > "$T/out.md" 2> "$T/run.err"
```

- Allow `git status` and `git diff` only as the exact commands listed, with no `*`: OpenCode matches the command's source text, so a deny such as `git diff*--output*` is bypassed by `--out''put`, and its wildcard reads a backslash as `/`, so no deny pattern can close that gap. Anything else, including `git diff HEAD~1` and `git difftool`, is refused by the `"*":"deny"` default. Give each acceptance check as its exact command, not as a prefix with `*`, and drop the `edit` denies for files the slice is meant to change. The `edit` map replaces the plain `"edit":"allow"`: `opencode run` still refuses anything that would ask, so list nothing as `ask`.
- Put the message before `-f`: `-f` takes every following word as a file. Never print `agent.json`: it lists the user's permission rules.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps the repository's own OpenCode config out; `--pure` runs without external plugins. `external_directory: deny` keeps edits inside the worktree; `"*_*":"deny"` removes every MCP tool, since OpenCode names them `<server>_<tool>`.
- Custom tools in `~/.config/opencode/tools/` (or `tool/`) are not plugins, so neither `--pure` nor `"*_*"` removes them. If the preflight stops with "riggverk-delegate also has: …", add `"<name>":"deny"` for each listed tool and run again.
- A refused tool call still exits 0, and an unknown or unavailable model exits 1 within seconds with the error on stderr. Judge by the diff.
- Resume: `opencode session list` from the worktree names the session; run the same command with `-s '<session-id>'` and the follow-up brief.

## Other CLIs

Use another agent CLI only when it has a documented non-interactive mode and its `--help` shows how to: start in a given directory, keep writes inside it, refuse network or at least push, turn off its subagents and MCP servers, close stdin, and write the final message to a file. Without all of that, use a subagent or do not delegate.
