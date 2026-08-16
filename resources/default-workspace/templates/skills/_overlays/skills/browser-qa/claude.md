### Claude Browser QA

- When the Claude Code Browser pane tools are available, prefer them: `preview_start` (a `.claude/launch.json` entry or a URL) to launch or attach, `navigate` plus `read_page`/`find` for structure, `read_console_messages` and `read_network_requests` for failures, `resize_window` presets for responsive checks, and screenshots as evidence.
- Attach to an already-running dev server with a url-only launch entry instead of starting a duplicate.
- Without browser tooling, fall back to available automation (Playwright, curl smoke) and state what could not be exercised.
