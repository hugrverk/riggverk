# Orchestrate caps and routes

How `orchestrate` decides how many lanes run at once, which route takes which kind of slice, and where the ledger goes. It works with no setup: the defaults run on the first try, and the user changes a value in one short phrase.

## Values

- **lanes**: how many agents may run at once, in total. A whole number from 1 to 8.
- **mechanical**: the route for mechanical slices (renames, codemods, boilerplate).
- **critical**: the route for critical implementation (data, persistence formats, public contracts).
- **ledger**: the path of the ledger file, or a directory to put it in.

A route is `<harness>[/<model>]`. `<harness>` is `codex`, `claude`, `opencode` or `lead`; `lead` means you do those slices yourself. `<model>` is optional and is everything after the first `/`, so an OpenCode `provider/model` fits. Without a model the harness's configured default applies.

## Lookup order

For each value on its own, the first source that sets it wins:

1. **Chat.** What the user says in this conversation, in any language, for this run only: "three lanes", "use Codex for the mechanical slices", "keep critical work yourself", "ledger in docs/context".
2. **Rules line.** One line in the user's own rules text, below the `<!-- END RIGGVERK BASE -->` marker (Cursor users put it in their User Rules):

   `Orchestrate: lanes=<n>, mechanical=<harness>[/<model>], critical=<harness>[/<model>], ledger=<path>`

   Any part may be left out, for example `Orchestrate: lanes=3, mechanical=codex`.
3. **Default.** `lanes=2`; `mechanical` is the route `dispatch` resolves from the user's words, rules and preflights; `critical=lead`; the ledger path follows the Ledger section of `SKILL.md`.

Other rules still apply. A rule that prefers or forbids a route (for example a delegation section that says when Codex may be used) is read by `dispatch` when a lane starts and can drop a route this file chose: take the next candidate and say so.

## Validation

- The harness must be one of the four values above. The model must match `^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$`; pass it as one quoted argument and never build a command string from it.
- `lanes` above what the harness allows is lowered to that limit.
- `ledger` must not be inside the OS temp directory and must not contain `..`.
- An invalid value is ignored, the next source decides, and the start line says so.

## Start line

Before the first lane starts, print one line in the user's language with each value and where it came from (`chat`, `rules` or `default`), and how to change it:

```text
Orchestrate: lanes=2 (default), mechanical=codex (rules), critical=lead (default), ledger=<git dir>/orchestrate/<slug>.md (default). Change: say "three lanes", or add "Orchestrate: lanes=3" below END in your rules.
```
