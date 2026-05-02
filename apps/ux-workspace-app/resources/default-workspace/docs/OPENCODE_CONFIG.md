# OpenCode Config

## Source template

The source template for OpenCode configuration is `templates/opencode.json`. This file defines:

- Share settings (recommended: disabled)
- Permission model (which operations are allowed, denied, or require asking)
- File-scope read/edit deny rules for secrets and credentials
- Watcher ignore patterns

## Permission model

The default template is conservative:

- Sharing is disabled
- Most operations default to "ask"
- Read access is broadly allowed except for secret-bearing files (`.env`, keys, certificates, auth files)
- Write access is restricted to source code directories
- Destructive commands (`sudo`, `rm -rf`, pipe-to-bash) are denied

## Sync workflow

1. Review the template at `templates/opencode.json`
2. Run `--diff` to see differences between the template and your current config
3. Run `--apply` to write the template to `~/.config/opencode/opencode.json`

A backup is created before overwriting if the current config differs.

## Customization

The template is user-editable. Add project-specific allow/deny rules as needed. Avoid weakening the secret-file deny rules in the `read` and `edit` sections.
