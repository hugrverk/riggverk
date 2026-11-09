# Adversarial roles

How every adversarial skill decides who implements and who criticises. It works with no setup: the defaults run on the first try, and the user changes a role in one short phrase. Every adversarial skill carries an identical copy of this file in its own folder, so none reads another skill's folder; `scripts/check-skill-routing.py` fails when the copies differ.

## Roles

- **lead**: this session, always. It writes the briefs, runs every proof and the verification, and decides. Not configurable.
- **implementer**: the agent that changes code, in skills that change code.
- **critic**: the fresh, read-only agent that attacks the work each round.
- **adversary**: the critic of `adversarial-test`: a fresh, read-only agent that proposes failing tests each round, which the lead writes into the tree.

Verification is never a role choice: the lead runs it. A `verifier` value anywhere is ignored.

## Lookup order

For each role on its own, the first source that sets it wins:

1. **Chat.** What the user says in this conversation, in any language, for this run only. Examples: "critic: claude", "critic=codex/<model>", "use Codex as the critic", "implementer: opencode", "adversary: codex".
2. **`roles.json`** in the running skill's own directory (next to its `SKILL.md`), if present. It is optional and nothing creates it by default. Shape:

   ```json
   {
     "schema_version": 1,
     "critic": { "harness": "codex", "model": "example-model" },
     "implementer": { "harness": "lead" }
   }
   ```

   An `adversary` key takes the same shape. Ignore the whole file, and say so, when it is not valid JSON or `schema_version` is not 1.
3. **Rules line.** One line in the user's own rules text, below the `<!-- END RIGGVERK BASE -->` marker (Riggverk's Library edits that text; Cursor users put it in their User Rules):

   `Adversarial roles: critic=<harness>[/<model>], adversary=<harness>[/<model>], implementer=<harness>[/<model>]`

   Any part may be left out, for example `Adversarial roles: critic=claude/opus`.
4. **Default**, below.

## Values

- `<harness>` is `codex`, `claude`, `opencode`, or `lead` (your own harness). A critic or adversary on your own harness is always a fresh subagent, never the lead itself.
- `<model>` is optional and is everything after the first `/`, so an OpenCode `provider/model` fits: `critic=opencode/<provider>/<model>`. Without a model the harness's configured default applies.
- Validate before use: the harness must be one of the values above, and the model must match `^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$`. Pass the model as one quoted argument; never build a command string from it. An invalid or unsupported value is ignored, the next source decides, and the start line says so.
- Supported implementers: your harness's own path (the skill's Harness notes) and, from Claude Code, Codex. Any other implementer value falls back to the default.
- Offered critics and adversaries: in-harness subagents, and Codex, Claude Code and OpenCode through `critic-recipes.md`. Cursor criticises only through its own subagents; Copilot, Pi and Kilo are not offered.

## Default

- **Implementer**: your harness's own implementer path from the skill's Harness notes.
- **Critic** and **adversary** (each on its own): list the candidates: every external route whose preflight passes (`critic-recipes.md`) and a fresh read-only subagent of your own harness on its strongest model. Drop any candidate clearly weaker than the implementer's model. Among the rest prefer another model family than the implementer's; when you cannot tell which model is stronger, treat them as comparable. If no other-family candidate is left, use the same-harness subagent.

Never ask the user to configure anything before the first run. A failed preflight or route is reported, not fatal.

## Start line

Before the first round, print exactly one line in the user's language: each role with its route and model, where it came from (`default`, `chat`, `roles.json` or `rules`), and how to change it. Add a few words when a source was ignored or a route failed.

```text
Roles: implementer=claude subagent (default), critic=codex/<model> (default: other family, comparable, preflight ok). Change: say "critic: claude", or add "Adversarial roles: critic=claude" below END in your rules.
```

## Ledger line

At the end, print one line in the user's language, after the report: terminal state and rounds, findings accepted, rejected and unproven, the critic route and model with its source, and what the simplification round removed (omit it in skills without one).

```text
Ledger: Approved after 2 rounds; findings 3 accepted, 1 rejected, 2 unproven; critic codex/<model> (default); simplification -6 lines.
```
