---
name: grill-me
description: Interview the user to sharpen an idea, plan, or design. Use when explicitly asked to grill them; never start on your own. Not for writing an implementation plan or building a prototype.
license: MIT
disable-model-invocation: true
metadata:
  category: workflow
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: implementation-plan, prototype
  source: https://github.com/mattpocock/skills (grill-me and grilling, MIT, commit 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d)
---

# Grill Me

Use an interview to clarify decisions about any idea, with or without a repository. Write no files and do not write an implementation plan during the interview, including in plan mode.

Done when: the user ends the interview or the decision tree is settled, and a short summary is posted in chat.

## Invocation

Run only on an explicit request, such as `/grill-me`, `$grill-me`, "grill me on this", or "grilla mig". Some harnesses ignore `disable-model-invocation`; in those harnesses keep the same rule yourself and never start this interview on your own.

## Interview

1. At the start, remind the user once that they own the scope and can push back, say "don't know", or stop at any time.
2. Map the idea as a tree of decisions and their dependencies. Find facts in available code, files, documentation, or other environment evidence instead of asking the user for facts you can look up. Use a subagent for fact-finding if available and permitted. An unresolved fact is a prerequisite: investigate it while asking independent decisions where possible.
3. In each round ask the whole current frontier: all decisions whose prerequisites are settled. Never ask a question that depends on another unanswered question, including one in the same round. Ask for decisions rather than facts. Prefer open questions over pre-baked choices.
4. Present each question in plain text with a number, a short title, the question, and your recommended answer on its own line. The user can answer by number. If the user's rules ask for the harness's question tool, use it and put the recommendation first among its options.
5. Wait for answers, update the tree, and repeat without a numeric round limit. If a decision about look, feel, or layout needs something concrete to react to, identify it as needing a prototype and suggest `prototype`; resume the interview after there is something to assess. Continue independent questions where possible.
6. When the user says they are done (for example, "wrap up"), or the tree is settled, post a short decision summary in chat: decided items, one line each; still open; and items needing a prototype. Optionally suggest a next step such as `implementation-plan`. Do not write a file.

## Harness notes

### Light harnesses

If automatic invocation controls are unavailable, enforce the explicit-request rule in the Invocation section. Use the plain-text round format unless the user's rules require the harness's question tool.
