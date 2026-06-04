---
name: zoom-out
description: Explain unfamiliar code in broader system context. Use when the user needs module relationships, callers, dependencies, risks, or safe next steps before editing.
disable-model-invocation: true
category: architecture
risk: low
targets: codex, opencode, claude
related: diagnose
---

# Zoom Out

Give the map before changing code.

## Process

1. Identify the local code or behavior under discussion.
2. Trace callers, dependencies, data flow, and external effects.
3. Explain how this area fits into the larger system.
4. Note constraints from tests, docs, config, APIs, storage, or deployment.
5. Identify risks and safe next steps.

## Output

- Local responsibility.
- Upstream callers and downstream dependencies.
- Relevant data or state flow.
- Risk points.
- Smallest safe next action.
