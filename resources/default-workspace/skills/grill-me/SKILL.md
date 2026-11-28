---
name: grill-me
description: Interview the user to sharpen an idea, plan, or design. Use when explicitly asked to grill them; never start on your own. Not for writing an implementation plan or building a prototype.
license: MIT
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

Run only on an explicit request, such as `/grill-me`, `$grill-me`, "grill me on this", or "grilla mig". The model can see this skill so that plain words can start it; never start this interview on your own.

## Interview

1. At the start, remind the user once that they own the scope and can push back, say "don't know", or stop at any time.
2. Map the idea as a tree of decisions and their dependencies. Find facts in available code, files, documentation, or other environment evidence instead of asking the user for facts you can look up. Use a subagent for fact-finding if available and permitted. An unresolved fact is a prerequisite: investigate it while asking independent decisions where possible.
3. In each round ask the whole current frontier: all decisions whose prerequisites are settled. Never ask a question that depends on another unanswered question, including one in the same round. Ask for decisions rather than facts. Prefer open questions over pre-baked choices.
4. Ask each round through the harness's question tool when it has one (see Harness notes): one question per decision, with a short header, two to four answers with your recommended answer first and marked as recommended, and one line per answer on what it leads to. Write each question so it can be read on its own. The tool adds a free-text answer itself, so add no "Other" option. Split a round that holds more questions than one call takes across calls, in dependency order. Without such a tool, present each question in plain text with a number, a short title, the question, and your recommended answer on its own line; the user can answer by number.
5. Wait for answers, update the tree, and repeat without a numeric round limit. If a decision about look, feel, or layout needs something concrete to react to, identify it as needing a prototype and suggest `prototype`; resume the interview after there is something to assess. Continue independent questions where possible.
6. When the user says they are done (for example, "wrap up"), or the tree is settled, post a short decision summary in chat: decided items, one line each; still open; and items needing a prototype. Optionally suggest a next step such as `implementation-plan`. Do not write a file.

## Harness notes

### Claude Code

- Question tool: `AskUserQuestion`, up to four questions per call with two to four answers each.

### Codex

- Question tool: `request_user_input`, up to three questions per call with two or three answers each. Codex offers it in Plan mode and waits for the answer. Outside Plan mode use `request_user_input_async` when it is offered, then end the turn and wait for the reply; otherwise use the plain-text format. Checked on Codex 0.171.0 that both tools are offered; not tried in a session.

### OpenCode

- Question tool: `question`, in the agents that have it. Riggverk's `architect` and OpenCode's `plan` do; `build` does not (OpenCode 1.19.6).

### Light harnesses

If automatic invocation controls are unavailable, enforce the explicit-request rule in the Invocation section. Use the harness's question tool when it has one, and the plain-text round format otherwise.
