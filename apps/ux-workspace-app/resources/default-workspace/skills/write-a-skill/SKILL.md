---
name: write-a-skill
description: Create or revise agent skills with minimal structure. Use when the user wants to add, edit, compress, or review a skill.
category: workflow
risk: low
targets: codex, opencode, claude, auggie
related: context-budget
---

# Write A Skill

Prefer editing an existing skill over creating a new one.

## Process

1. **Check fit.**
   - Is there an existing skill to adapt?
   - Is the workflow reusable across repos?
   - Is it better as repo guidance in `AGENTS.md`?

2. **Define scope.**
   - Task covered.
   - Trigger phrases or contexts.
   - Required inputs.
   - Expected output.

3. **Write the skill.**
   - Keep valid YAML frontmatter.
   - Keep `description` short and trigger-focused.
   - Use direct numbered steps.
   - Link extra references only when the main file would become too long.
   - Add scripts only for deterministic repeated work.

4. **Review.**
   - Skill is agent-neutral unless a tool is required.
   - No secrets or time-sensitive facts.
   - No broad philosophy.
   - No unbounded interviewing.
   - Clear verification or output expectations.

## Minimal Shape

```markdown
---
name: skill-name
description: What it does. Use when specific trigger applies.
---

# Skill Name

## Process

1. Step.
2. Step.

## Output

- Expected result.
```
