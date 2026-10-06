---
context: fork
agent: verifier
background: false
allowed-tools: Bash(git status *) Bash(git log *) Bash(git diff *) Bash(head *) Bash(tail *)
---
### Claude Release Check

Runs in a forked verifier context; report the full gate result back, not a summary of intent.

Repository state when this check loaded:

- Branch and status: !`git status --short --branch 2>/dev/null | head -c 1200`
- Recent commits: !`git log --oneline -10 2>/dev/null | head -c 800`
- Working diff: !`git diff --stat 2>/dev/null | tail -4`
