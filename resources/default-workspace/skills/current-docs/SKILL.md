---
name: current-docs
description: Check official or primary current documentation when implementation depends on version-specific APIs, SDKs, CLIs, config, hooks, or platform behavior.
category: docs
risk: low
targets: codex, opencode, claude, cursor
---

# Current Docs

## Purpose

- Prevent stale assumptions about libraries, frameworks, SDKs, CLIs, APIs, models, tools, and platforms.
- Use current primary sources only where freshness changes implementation risk.
- Keep documentation lookup small, cited, and actionable.

## When To Use

- The task depends on framework/library APIs, SDK methods, CLIs, config formats, hooks, plugin APIs, package versions, model/tool docs, or platform behavior.
- You are unsure whether recalled behavior is current.
- The codebase version is newer than your known baseline.
- An error suggests changed flags, deprecated APIs, renamed options, or altered defaults.
- Adding or upgrading dependencies, plugins, SDKs, MCP servers, tools, or platform integrations.

## Do Not Use When

- The fact is stable and directly inspectable in the local repo.
- Local code, tests, types, generated docs, or lockfiles already answer the question.
- The task is broad research without an implementation decision.
- Using external docs would require sending secrets, private URLs, auth headers, cookies, or credential-bearing config.

## Source Order

1. Local repo code, lockfiles, typed definitions, generated schemas, and installed package docs.
2. Official documentation or primary API reference.
3. Source repository, examples maintained by the project, changelog, release notes, migration guide, or issue/discussion from maintainers.
4. Secondary sources only as pointers to primary evidence, not as authority.

## Process

1. State the behavior that must be current.
2. Identify the project version from local files when possible.
3. Check primary sources for only the relevant API, command, option, config, lifecycle, or platform behavior.
4. Redact any user-provided secrets before external queries.
5. Compare docs to local code:
   - Supported version.
   - Deprecations or breaking changes.
   - Required imports, flags, options, or config fields.
   - Runtime/environment constraints.
6. Apply the smallest implementation impact from the docs.
7. Cite the source and the exact behavior that matters.
8. State uncertainty when current docs are unavailable or version alignment cannot be proven.

## Output

- Current behavior needed.
- Sources checked.
- Version or applicability.
- Implementation impact.
- Commands run or files inspected.
- Uncertainty or gaps.

## Guardrails

- Do not dump large documentation excerpts into reports.
- Do not browse for local repo facts that can be inspected directly.
- Do not treat outdated blog posts as authoritative.
- Do not claim "latest" or "current" unless current primary evidence was checked.
