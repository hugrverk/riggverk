---
name: to-prd
description: Convert current context into a concise solo-developer PRD, feature brief, or implementation-ready product spec.
category: planning
risk: low
targets: codex, opencode, claude
related: implementation-plan
---

# To PRD

Synthesize what is already known. Ask only when a missing decision blocks execution.

## Process

1. Read the conversation, linked issue/spec, relevant repo docs, and nearby code if needed.
2. Identify the user problem, desired outcome, constraints, and non-goals.
3. Note the likely implementation surface at module level, not fragile file-by-file instructions.
4. Choose a verification strategy focused on observable behavior.
5. Produce the PRD. Publish to an issue tracker only if the user asks or repo guidance requires it.

## PRD Shape

```markdown
## Problem

## Goal

## Scope

## Non-goals

## User-visible behavior

## Implementation notes

## Acceptance criteria

## Verification

## Open questions
```

Keep it execution-ready. Avoid product bureaucracy, inflated user stories, and speculative architecture.
