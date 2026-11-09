---
name: context-budget
description: Audits always-loaded and on-demand agent instructions (rules, skill descriptions and bodies, agent prompts, tool config) for token cost, duplication, and contradictions, and proposes small safe cuts. Use when adding skills or rules, or when instructions feel bloated, repetitive, or conflicting.
license: MIT
metadata:
  category: workflow
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: implementation-plan
  source: https://github.com/mattpocock/skills (writing-for-agents, MIT)
---

# Context Budget

Done when: each recommendation names the file, measured bytes saved, behavior risk, and the check showing no safety rule was lost.

## Do Not Use When

- The user asked for feature implementation, debugging, or release readiness.
- The content is outside the workspace scope.
- The proposed optimization would remove critical safety, security, repo-canon, or verification guidance.
- Broad deletions are desired but not explicitly requested.

## Process

1. Define the inspectable scope:
   - Skills.
   - Global rules.
   - Agent prompts.
   - Docs.
   - Tool/MCP config.
2. Measure the always-loaded surface first: rules files, skill `description` text, agent descriptions, tool schemas. Bodies load on demand and rank lower.
   - Count bytes (`wc -c`), files, and lines; estimate tokens only as an estimate.
   - Note always-loaded vs optional or on-demand content.
3. Identify duplication:
   - Repeated safety rules.
   - Overlapping skill triggers.
   - Broad generic advice repeated across docs.
   - Tool-specific instructions that should be agent-neutral.
   - Long examples that could become references or be removed.
4. Apply writing-for-agents checks to each instruction:
   - No-op test: an instruction the model already follows by default changes nothing; delete the whole sentence.
   - Sediment: stale layers that survived because adding felt safe and removing felt risky; drop lines that no longer bear on the task.
   - Single source of truth: keep each meaning in one place; do not restate what the repo, config, or `--help` already shows.
   - Pointer wording: a pointer (skill description, rule line naming a doc) decides when material is reached, so sharpen it before inlining the target; one trigger per branch.
5. Classify each component:
   - Keep.
   - Merge.
   - Shorten.
   - Make optional/on-demand.
   - Remove.
6. Protect essential content:
   - Credentials and secret-handling rules.
   - Git/destructive-action guardrails.
   - Verification requirements.
   - Repo-canon instructions.
   - Safety and security review boundaries.
7. Prioritize by savings and risk:
   - Highest line/token savings.
   - Lowest behavioral risk.
   - Clearest ownership.
   - Fewest sync surfaces.
8. Recommend small slices rather than one broad purge.

## Output

- Scope audited.
- Counts: files, lines, bytes, and rough token estimate when practical.
- Biggest bloat sources.
- Overlaps found.
- Keep/merge/shorten/optional/remove recommendations.
- Highest-savings next slice.
- Safety rules preserved.
- Not inspected.

## Guardrails

- Do not optimize away critical safety, security, verification, or repository instructions.
- Do not make broad deletions automatically unless explicitly asked.
- Do not audit one harness's copy only when the same rules or skills are installed for several agents.
- Do not claim token savings are exact unless measured with a tokenizer.
