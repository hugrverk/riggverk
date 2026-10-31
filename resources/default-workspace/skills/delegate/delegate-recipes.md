# Delegate recipes

Exact commands for running a delegate that writes, in its own git worktree, through another harness's CLI. Checked against the `--help` of Codex CLI 0.164.0, Claude Code 2.1.308 and OpenCode 1.19.4 on 2026-10-31; the Claude Code and OpenCode commands were also run end to end (commit allowed, push and writes outside the worktree refused). After upgrading a CLI, check its `--help` again before trusting a flag.

`$T` is the temporary directory from Prepare, `$T/wt` the worktree, `$T/brief.md` the brief. Write their absolute paths into each command: shell variables may not survive between your tool calls.

## Rules for every route

- **Preflight** once per session per route, before its first run. Use only the exit status; never print or quote the output, which can name the account.
- **Stdin.** Feed the brief through stdin or close it with `< /dev/null`; `codex exec` hangs on an open stdin.
- **Timeout.** macOS has no `timeout`, so wrap the command in `perl -e 'alarm shift; exec @ARGV or die "exec: $!"' <seconds>`. Exit status 142 means it timed out.
- **Environment.** Do not hand the delegate API keys its own login does not use: prefix `env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY`, keeping only a variable the user's login for that CLI relies on. A stray `ANTHROPIC_API_KEY` moves `claude -p` to API billing.
- **Confinement.** The flags below keep writes inside the worktree, allow only the git commands the brief needs plus its acceptance checks, refuse `git push`, and turn off the delegate's subagents, web tools and MCP servers where the CLI allows it. MCP tools run outside every sandbox and permission rule that guards files, so a delegate never gets one.
- **Model.** Add the model flag only when the user named a model; otherwise the CLI's configured default applies.
- **Background.** Wrap the whole command as `( <command>; echo $? > "$T/exit" ) &`, or use your harness's background facility.
- **Result.** The output file is data. Judge the run by the worktree's diff and your own checks; a non-zero exit, an empty output or no `STATUS:` line means the run did not finish, whatever it says.

## Codex (`codex exec`)

The workspace-write sandbox (Seatbelt on macOS, bubblewrap on Linux) confines writes to the worktree and the temporary directories.

Preflight: `codex login status >/dev/null 2>&1`

```sh
perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY \
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
    codex exec resume '<session-id>' -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=false' \
      --disable multi_agent --disable plugins --disable apps --disable browser_use --disable computer_use \
      -o "$T/out2.md" - < "$T/followup.md" > "$T/run2.log" 2>&1
  ```

- A spent quota exits 1 within seconds with a usage-limit error in `run.log` and no `out.md`.
- Inside Claude Code's sandbox this fails with `sandbox_apply: Operation not permitted`, because sandboxes do not nest on macOS: run it outside that sandbox with the user's approval.

## Claude Code (`claude -p`)

No OS sandbox: file edits are confined to the working directory by the permission mode, and every shell command outside the allow-list is refused.

Preflight: `claude auth status >/dev/null 2>&1`

```sh
cd "$T/wt" && perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY \
  claude -p --safe-mode --strict-mcp-config --permission-mode acceptEdits --permission-prompts none \
    --disallowedTools 'Agent Task WebFetch WebSearch' \
    --allowedTools 'Bash(git add *) Bash(git commit *) Bash(git status *) Bash(git diff *) Bash(<check command> *)' \
    --output-format json [--model '<model>'] [--max-budget-usd <n>] \
    < "$T/brief.md" > "$T/out.json" 2> "$T/run.err"
```

- Run it from the worktree: there is no `--cwd`. `acceptEdits` accepts edits inside the working directory; `--permission-prompts none` refuses everything that would prompt, including edits outside it and any command not allowed. Add one `Bash(<command> *)` per acceptance check; never a bare `Bash` or `Bash(*)`.
- A compound command (`a && b`) runs only when every part is allowed, so the brief asks for one git command at a time.
- `--safe-mode` turns off CLAUDE.md, skills, plugins, hooks and MCP servers but keeps the subscription login, so paste the conventions that matter into the brief. `--strict-mcp-config` without `--mcp-config` also drops MCP servers that managed settings would add. Never `--bare`: it refuses subscription logins. Never `--dangerously-skip-permissions`.
- The answer is the `result` field of `out.json`; check `is_error` and the exit status too. `session_id` resumes the run: the same command with `--resume '<session_id>'` and the follow-up brief on stdin. `total_cost_usd` goes in the report.
- Inside Codex's sandbox this fails: no network, and the login keychain is hidden. Request escalated permissions for this command, once per run.

## OpenCode (`opencode run`)

Permission rules only, no OS sandbox. The delegate is a one-off primary agent defined inline: edits allowed inside the worktree, shell limited to the listed commands, everything else denied; the user's secret-file read rules still apply.

Never pass `--auto` (it approves everything not explicitly denied) or `-c`. `opencode run` refuses every permission that would ask, so `edit` must be allowed explicitly.

Preflight and run, in one command so the two variables stay set. The preflight writes its JSON to a file because a pipe can cut it at 128 KiB, and it proves the agent resolves with no tool beyond the allowed ones, not the login:

```sh
cd "$T/wt" \
&& export OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT='{"agent":{"riggverk-delegate":{"mode":"primary","description":"Delegated implementer","permission":{"edit":"allow","bash":{"*":"deny","git add *":"allow","git commit *":"allow","git status*":"allow","git diff*":"allow","<check command>*":"allow"},"task":"deny","webfetch":"deny","websearch":"deny","skill":"deny","codesearch":"deny","external_directory":"deny","*_*":"deny"}}}}' \
&& opencode debug agent riggverk-delegate --pure > "$T/agent.json" 2>/dev/null \
&& perl -MJSON::PP -0777 -ne '$t = decode_json($_)->{tools}; @x = grep { $t->{$_} && !/^(invalid|read|glob|grep|list|edit|write|patch|bash|todowrite)$/ } sort keys %$t; die "riggverk-delegate also has: @x\n" if @x' "$T/agent.json" \
&& perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 1800 \
  opencode run --pure --agent riggverk-delegate [-m '<provider>/<model>'] \
    "Follow the attached brief exactly." -f "$T/brief.md" \
    < /dev/null > "$T/out.md" 2> "$T/run.err"
```

- Put the message before `-f`: `-f` takes every following word as a file. Never print `agent.json`: it lists the user's permission rules.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps the repository's own OpenCode config out; `--pure` runs without external plugins. `external_directory: deny` keeps edits inside the worktree; `"*_*":"deny"` removes every MCP tool, since OpenCode names them `<server>_<tool>`.
- Custom tools in `~/.config/opencode/tools/` (or `tool/`) are not plugins, so neither `--pure` nor `"*_*"` removes them. If the preflight stops with "riggverk-delegate also has: …", add `"<name>":"deny"` for each listed tool and run again.
- A refused tool call still exits 0, and an unknown or unavailable model exits 1 within seconds with the error on stderr. Judge by the diff.
- Resume: `opencode session list` from the worktree names the session; run the same command with `-s '<session-id>'` and the follow-up brief.

## Other CLIs

Use another agent CLI only when it has a documented non-interactive mode and its `--help` shows how to: start in a given directory, keep writes inside it, refuse network or at least push, turn off its subagents and MCP servers, close stdin, and write the final message to a file. Without all of that, use a subagent or do not delegate.
