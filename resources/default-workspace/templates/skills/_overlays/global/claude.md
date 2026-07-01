### Claude Code

- Use forked context and subagents for bounded exploration or specialist review only; pass explicit scope, tool boundaries, and expected evidence.
- Keep dynamic context tight. Read task-relevant files, avoid broad dumps, and summarize handoffs compactly.
- Do not rely on mutating hooks by default. File edits, shell commands, and external writes must stay within the active task and harness permissions.
- Final synthesis belongs in the parent context with changed files, verification, gaps, and residual risk.
