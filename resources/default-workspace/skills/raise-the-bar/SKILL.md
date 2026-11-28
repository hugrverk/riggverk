---
name: raise-the-bar
description: Proposes a higher bar for a task and stops for the user to pick. Use when explicitly asked (/raise-the-bar), never unasked.
license: MIT
metadata:
  category: planning
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: grill-me, implementation-plan, minimal-implementation
  source: https://github.com/robonuggets/be-ambitious (be-ambitious, MIT, commit dc116a3ebd8cf772e4d0930626f67369bd60399d), after Felix Rieseberg's article https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/
---

# Raise the Bar

Reframe a task at a higher bar, then stop. The result is a proposal the user picks from; it starts no work.

Done when: the goal as asked, the outcome it serves and at most three bounded options (the first is the task as asked) are posted with costs and checks, the user is asked to pick, and nothing has been edited or run.

## Invocation

Run only on an explicit request: `/raise-the-bar`, `$raise-the-bar` in Codex, or "raise the bar on this". The model can see this skill so that plain words can start it (Codex reads `agents/openai.yaml` and takes only `$raise-the-bar`); never start it because a task looks small.

The task is what follows the invocation, else the user's latest request. If there is none, ask for it in one line and stop.

## Where the ambition goes

Ambition raises the goal, the plan and the standard of proof. It does not raise the diff: whichever option the user picks is built with `minimal-implementation` (smallest safe diff), and the rules on scope, dependencies, CI, build config and asking first still hold. Better, not bigger: drop any idea that adds deliverables without making the outcome better.

## Process

1. Read the code or material the task touches before proposing anything (the files it names, the functions on its path) and ground each option in what you found, citing `file:line`; an option written without reading is a guess. Run nothing that writes, installs, reaches the network or starts another agent.
2. State the goal as asked in one line, and the outcome it serves in one line. If the outcome is unclear, say so instead of guessing.
3. Try each lever and keep only those that fit, usually one or two:
   - Altitude: aim at the outcome, not the instance (this crash becomes this class of crash; this report becomes the decision it feeds). Go one level up, no further, and never to a standing process that runs without the user.
   - Depth: how the best practitioner would do it beyond what was asked. Work from primary evidence (logs, data, the failing input) rather than someone's summary of it, use the field's own techniques and instruments, and pick a check that neither you nor the user controls (a test, a reproduction, a measurement) with its pass criterion.
   - Range: another discipline whose method would change the result (a security reviewer, an editor, a statistician). Name the method it brings, not a voice to imitate.
4. Decide whether the bar should rise at all. A narrow fix with one right answer (an off-by-one, a typo, a wrong constant) should stay narrow: keep the task as asked and raise only the proof, such as a regression test that fails first. "Keep it as asked" is a valid result; say it plainly.
5. Write the options:
   - Option 1 is always the task as asked, with the check that proves it (for a fix, a regression test that fails before the fix).
   - Options 2 and 3, only where a lever fits: the higher goal in one line, why it is worth more, what it costs (files or areas touched, review load, access it needs), the outside check and its pass criterion, where it stops, and what it will not do.
   - No option adds a production, network or outward step (deploy, publish, post, message anyone). Mark any step that widens scope, touches shared systems, CI, build config or dependencies, or starts other agents as "needs your ok", never as a plain step.
6. Name missing access or data plainly. Never invent a source, tool, number or result.
7. Recommend one option in one line (it may be option 1), ask the user to pick or adjust, and stop.

## Output

- Goal as asked; outcome it serves.
- Levers that fit, and those skipped, one line each.
- The options, as in step 5.
- Recommendation and the question.

Keep it short: a small task gets a few lines per option.

## Guardrails

- Proposal only: no edits, no commands with side effects, no subagents, no network.
- The higher bar changes what is aimed at and how it is proven; tool access and permissions stay as they are.
- No self-grading: an option's value is a claim until its named check runs.
- Never present an option as started, done or proven.

## Harness notes

### Light harnesses

If automatic invocation controls are unavailable, enforce the explicit-request rule in the Invocation section.
