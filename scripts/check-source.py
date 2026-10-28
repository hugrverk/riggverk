#!/usr/bin/env python3
"""Guard app source invariants that no unit test reaches.

Groups:
  identity       product name Riggverk; legal files; stable technical identifiers and paths
  tauri-conf     bundled workspace resource; main window size; no maximize at startup
  startup-order  the app data move runs first in the Tauri setup closure
  forbidden      no shell command strings, eval or remote skill installs in scripts and source;
                 no project-target or page-scoped install actions; rendered OpenCode compares
  require        markers and the Rust regression tests that replaced older source greps
  ui             offline-first UI, dev-only mock backend, design and typography rules

Files come from git (tracked plus untracked, not ignored); see scripts/guards.py.

Usage: python3 scripts/check-source.py [--group NAME[,NAME]] [--root PATH]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from guards import Rule, check, iter_files  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = "resources/default-workspace/"

# Built from fragments so this file does not itself contain the names it bans.
_HOLDER = "Matt Poc" "ock"
_OLD = "ux-work" "space"
_LEGACY_NAMES = "|".join(
    (_OLD, "UX_WORK" "SPACE", "ux_" "workspace", r"\." + _OLD, _OLD + "-app", r"ai\.open" "workspace")
)
# The name before the Riggverk rename, in its prose, path and app id forms. The residue guard
# (scripts/check-public-residue.py) covers every spelling; these rules keep the specific places.
_PRODUCT = "Agent " "Workspace"
_FIRST_DEFAULT = "~/" + _PRODUCT
_EARLIER_APP_ID = r"ai\.agent" r"workspace\.app"
_EARLIER_APP_ID_SAMPLE = "ai.agent" "workspace.app"
_EARLIER_STATE = "agent" "-workspace"

IDENTITY = (
    Rule("license-holder", "forbid", _HOLDER, ("LICENSE",), "LICENSE must not name the stale copyright holder", _HOLDER),
    Rule("notice-attribution", "require", _HOLDER, ("NOTICE.md",), "NOTICE.md must keep the upstream attribution", _HOLDER),
    Rule("readme-links-notice", "require", r"NOTICE[.]md", ("README.md",), "README.md must link NOTICE.md", "[NOTICE.md](./NOTICE.md)"),
    Rule("html-title", "require", r"<title>Riggverk</title>", ("index.html",), "the app HTML title must be Riggverk", "<title>Riggverk</title>"),
    # Markers, env vars and paths in users' files and environments are named Riggverk; the earlier
    # names are read only through LEGACY_* constants. Env var names are not reachable by unit tests
    # without being set.
    Rule(
        "env-workspace-path",
        "require",
        r"RIGGVERK_WORKSPACE_PATH",
        ("src-tauri/src/env_overrides.rs",),
        "the RIGGVERK_WORKSPACE_PATH env var must stay in env_overrides.rs",
        'pub const WORKSPACE_PATH_ENV: &str = "RIGGVERK_WORKSPACE_PATH";',
    ),
    Rule(
        "env-backup-dir",
        "require",
        r"RIGGVERK_BACKUP_DIR",
        ("src-tauri/src/env_overrides.rs",),
        "the RIGGVERK_BACKUP_DIR env var must stay in env_overrides.rs",
        'pub const BACKUP_DIR_ENV: &str = "RIGGVERK_BACKUP_DIR";',
    ),
    Rule(
        "rules-marker",
        "require",
        r"BEGIN RIGGVERK BASE",
        ("src-tauri/src/rules_block.rs",),
        "the rules markers must stay BEGIN/END RIGGVERK BASE in rules_block.rs",
        "<!-- BEGIN RIGGVERK BASE -->",
    ),
    Rule(
        "old-product-name",
        "forbid",
        _PRODUCT,
        ("src/", "README.md", "index.html", "src-tauri/tauri.conf.json"),
        'old product name in app sources (use Riggverk)',
        f"Welcome to {_PRODUCT}",
        # Release notes may name the app a release replaces; the app shows them in what's new.
        exclude=("src/generated/release-notes.json",),
    ),
    # The previous app data directory name belongs only to the migration code (src-tauri) and to
    # the move and undo note in docs/RELEASE.md.
    Rule(
        "legacy-app-data-dir",
        "forbid",
        _EARLIER_APP_ID,
        ("README.md", "src/", "resources/", "docs/"),
        "previous app data directory name outside docs/RELEASE.md (use se.hugrverk.riggverk)",
        f"~/Library/Application Support/{_EARLIER_APP_ID_SAMPLE}",
        exclude=("docs/RELEASE.md",),
    ),
    Rule(
        "deprecated-install-path",
        "forbid",
        re.escape(_FIRST_DEFAULT),
        ("src/lib/settingsDraft.ts", "src/views/StartView.tsx", "src/App.tsx"),
        "deprecated first built-in default in active frontend sources",
        f'const path = "{_FIRST_DEFAULT}";',
    ),
    Rule(
        "installed-workspace-constant",
        "require",
        r"DEFAULT_INSTALLED_WORKSPACE_DISPLAY",
        ("src-tauri/src/path_utils.rs",),
        "canonical installed workspace constant must stay in path_utils.rs",
        "pub const DEFAULT_INSTALLED_WORKSPACE_DISPLAY: &str",
    ),
    Rule(
        "frontend-install-path",
        "require",
        r"~/\.config/riggverk",
        ("src/lib/settingsDraft.ts", "src/views/StartView.tsx"),
        "the frontend must show the canonical ~/.config/riggverk path",
        '"~/.config/riggverk"',
    ),
    Rule(
        "mistaken-install-path",
        "forbid",
        r"\.config/\.(riggverk|" + _EARLIER_STATE + ")",
        ("src/", "src-tauri/", "README.md", "docs/", BUNDLE),
        "mistaken install path ~/.config/.riggverk in active sources",
        "~/.config/.riggverk",
    ),
    Rule(
        "legacy-workspace-names",
        "forbid",
        _LEGACY_NAMES,
        (BUNDLE, "src-tauri/src/commands/defaults.rs", "src-tauri/src/commands/retired_workspace_files.rs"),
        "the bundled workspace, defaults.rs and the workspace copy list must not use the old workspace names",
        f"cp -R ~/{_OLD} .",
    ),
)

TAURI_CONF_RULES = (
    Rule(
        "tauri-resource",
        "require",
        r"default-workspace",
        ("src-tauri/tauri.conf.json",),
        "tauri.conf.json must bundle the default workspace resource",
        '"../resources/default-workspace/": "default-workspace/"',
    ),
    Rule(
        "no-maximize",
        "forbid",
        r"window\.maximize\(\)",
        ("src-tauri/src/lib.rs",),
        "Tauri startup must not maximize the main window",
        "window.maximize().ok();",
    ),
)
MAIN_WINDOW = {"width": 1280, "height": 800, "center": True}


def tauri_conf(root: Path) -> list[str]:
    try:
        window = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["app"]["windows"][0]
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        return [f"main-window: cannot read app.windows[0] from src-tauri/tauri.conf.json: {exc!r}"]
    actual = {key: window.get(key) for key in MAIN_WINDOW}
    if actual != MAIN_WINDOW:
        return [f"main-window: the main window must open centered at 1280x800, found {actual}"]
    return []


def startup_order(root: Path) -> list[str]:
    # Once anything reads or writes app data first, the first settings save would create the new
    # directory and strand the old data.
    try:
        src = (root / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    except OSError as exc:
        return [f"startup-order: cannot read src-tauri/src/lib.rs: {exc}"]
    setup = src.find(".setup(|app| {")
    hook = src.find("app_data_migration::run_at_startup()?;", setup) if setup != -1 else -1
    roots = src.find("setup_roots::initialize", setup) if setup != -1 else -1
    if setup == -1 or hook == -1 or roots == -1 or hook > roots:
        return [
            "startup-order: app_data_migration::run_at_startup()? must be the first call in the "
            "Tauri setup closure, before setup_roots::initialize"
        ]
    return []


# The guard's own definitions and their tests name the patterns on purpose.
SCAN_SCOPE = ("scripts/", "src-tauri/", "src/", f"{BUNDLE}scripts/")
SCAN_EXCLUDE = ("scripts/check-source.py", "scripts/test_check_source.py")
FORBIDDEN = (
    Rule(
        "shell-command-string",
        "forbid",
        r"(^|[^A-Za-z0-9_])(ba|z|da|k)?sh\s+-[a-z]*c([^A-Za-z0-9_-]|$)",
        SCAN_SCOPE,
        "sh -c / bash -lc command strings in scripts and source (spawn the program with argv)",
        'Command::new("bash").args(["-lc", script])  # bash -lc "$cmd"',
        exclude=SCAN_EXCLUDE,
    ),
    Rule(
        "eval",
        "forbid",
        r"(^|[^A-Za-z0-9_])eval([^A-Za-z0-9_]|$)",
        SCAN_SCOPE,
        "eval in scripts and source",
        'eval "$line"',
        exclude=SCAN_EXCLUDE,
    ),
    Rule(
        "npx-skills",
        "forbid",
        r"npx\s+skills",
        SCAN_SCOPE,
        "remote skill installs (npx skills) in scripts and source",
        "npx skills add owner/repo",
        exclude=SCAN_EXCLUDE,
    ),
    Rule(
        "skills-latest",
        "forbid",
        r"skills@latest",
        SCAN_SCOPE,
        "unpinned skills@latest in scripts and source",
        "npx skills@latest add",
        exclude=SCAN_EXCLUDE,
    ),
    # The app installs into the user's global harness folders only, through one reviewed plan.
    Rule(
        "project-target-install",
        "forbid",
        r"cursorProjectTarget|cursor_diff_project|cursor_sync_project|onCursorDiffProject|onCursorSyncProject"
        r"|dry-run project|sync project|installScope|installTarget|Project install target|Project scope needs"
        r"|validate_project_install_target|project scope requires",
        ("src/", "src-tauri/"),
        "the app must not expose project-target sync or install actions",
        "const installTarget = cursorProjectTarget;",
    ),
    Rule(
        "page-scoped-agent-sync",
        "forbid",
        r"sync_claude_agents|diff_claude_agents|sync_opencode_agents|diff_opencode_agents",
        ("src/",),
        "harness pages must not wire their own agent sync; the reviewed install plan owns it",
        'invoke("sync_claude_agents")',
    ),
    Rule(
        "opencode-health-raw-compare",
        "forbid",
        r"file_eq\(&template_config_path, &installed_config_path\)",
        ("src-tauri/src/commands/opencode_runtime.rs",),
        "OpenCode health must not byte-compare the raw templates/opencode.json",
        "let ok = file_eq(&template_config_path, &installed_config_path);",
    ),
    # A folder is valid by its own state (`.riggverk/`); bundled copies as markers would let a
    # removed copy invalidate a folder and drop a saved custom path with its ownership records.
    Rule(
        "workspace-validity-bundle-markers",
        "forbid",
        r'"(templates/[^"]*|skills|README\.md)"',
        ("src-tauri/src/commands/workspace.rs",),
        "workspace validity must not use bundled files (templates/, skills, README.md) as markers",
        'rel_path: "templates/global-agent-rules.md",',
    ),
)

# Rust tests that replaced older release-check source greps. Deleting one would drop that guard
# silently, so its name stays pinned here; the full `cargo test` run proves it passes.
REQUIRED_RUST_TESTS = (
    ("src-tauri/src/agent_targets.rs", "cursor_setup_is_agents_not_rules"),
    ("src-tauri/src/agent_targets.rs", "cursor_setup_not_in_runtime_agent_targets"),
    ("src-tauri/src/agent_targets.rs", "bundled_config_targets_exclude_cursor_setup"),
    ("src-tauri/src/agent_targets.rs", "opencode_config_target_syncs_generated_opencode_json"),
    ("src-tauri/src/commands/content.rs", "cursor_setup_is_not_a_bundled_config_template"),
    # Workspace validity is the data folder itself, never bundled copies in it.
    ("src-tauri/src/commands/workspace.rs", "absent_default_data_folder_is_valid"),
    ("src-tauri/src/commands/workspace.rs", "symlinked_data_folder_is_invalid"),
    ("src-tauri/src/commands/workspace.rs", "custom_folder_with_only_managed_state_is_valid_and_kept"),
    ("src-tauri/src/commands/workspace.rs", "custom_folder_stays_configured_when_bundled_copies_are_deleted"),
    ("src-tauri/src/commands/workspace.rs", "fresh_profile_installs_a_harness_without_a_workspace_copy"),
    ("src-tauri/src/commands/workspace.rs", "launch_reads_never_create_the_data_folder"),
    ("src-tauri/src/commands/retired_workspace_files.rs", "the_frozen_list_matches_the_list_it_was_frozen_from"),
    ("src-tauri/src/commands/retired_workspace_files.rs", "every_listed_path_is_in_the_bundle_or_documented_as_retired"),
    ("src-tauri/src/cursor_profile_ops.rs", "cursor_backups_are_owner_only"),
    ("src-tauri/src/commands/opencode_runtime.rs", "test_configs_match_pass_when_template_has_playwright_placeholders"),
    ("src-tauri/src/commands/opencode_runtime.rs", "test_configs_match_warn_when_rendered_expected_differs"),
)
REQUIRE = (
    # Codex reads $CODEX_HOME/skills when CODEX_HOME is customised and ~/.agents/skills by default.
    Rule(
        "codex-skills-custom-home",
        "require",
        r'codex_home\(home\)\.join\("skills"\)',
        ("src-tauri/src/agent_skill_targets.rs",),
        "the Codex home skills folder must be $CODEX_HOME/skills (used with a customised CODEX_HOME)",
        'codex_home(home).join("skills")',
    ),
    Rule(
        "codex-skills-default",
        "require",
        r'home\.join\("\.agents"\)\.join\("skills"\)',
        ("src-tauri/src/agent_skill_targets.rs",),
        "the default Codex skills folder must be ~/.agents/skills",
        'home.join(".agents").join("skills")',
    ),
    Rule(
        "app-install-screen",
        "require",
        r"useInstallScreen",
        ("src/App.tsx",),
        "App.tsx must route workspace installation through the reviewed install screen",
        "const install = useInstallScreen();",
    ),
    Rule(
        "opencode-health-rendered",
        "require",
        r"render_expected_opencode_config|installed_config_matches_rendered",
        ("src-tauri/src/commands/opencode_runtime.rs",),
        "OpenCode health must compare the installed config to the rendered workspace config",
        "let expected = render_expected_opencode_config(&workspace)?;",
    ),
) + tuple(
    Rule(
        f"rust-test-{name}",
        "require",
        rf"\bfn {name}\(",
        (path,),
        f"regression test {name} must stay in {path}",
        f"    fn {name}() {{",
    )
    for path, name in REQUIRED_RUST_TESTS
)

STYLES = ("src/styles/",)
UI = (
    # Design rules: no heavy selected-state bars.
    Rule(
        "selected-inset-bar",
        "forbid",
        r"box-shadow:[^;]*inset (2px 0|0 -2px)",
        STYLES,
        "heavy inset selected-state bars are not allowed",
        "  box-shadow: inset 2px 0 var(--accent);",
    ),
    Rule(
        "selected-left-border",
        "forbid",
        r"border-left:[^;]*2px solid (var\(--accent\)|currentColor)",
        STYLES,
        "heavy decorative selected left borders are not allowed",
        "  border-left: 2px solid var(--accent);",
    ),
    # Typography plumbing the vitest suites do not read from the stylesheets.
    Rule(
        "app-font-css-vars",
        "require",
        r"--app-font-size|--app-font-scale",
        STYLES,
        "the app font-size setting must drive CSS variables",
        "  font-size: var(--app-font-size);",
    ),
    Rule(
        "typography-vars",
        "require",
        r"--text-xs|--text-sm|--text-base|--text-lg|--text-heading|--font-size-heading|--text-display",
        STYLES,
        "semantic typography variables must exist",
        "  --text-sm: 0.875rem;",
    ),
    Rule("no-css-zoom", "forbid", r"zoom:\s*[^;]+", STYLES, "typography scaling must not use CSS zoom", "  zoom: 1.2;"),
    Rule("form-font-inherit", "require", r"font:\s*inherit", STYLES, "form controls must inherit typography", "  font: inherit;"),
    Rule(
        "library-docs-surface",
        "require",
        r"lib-docs-markdown",
        ("src/views/library/DocContent.tsx",),
        "the Library document preview must render the scoped reading surface",
        '<div className="lib-docs-markdown">',
    ),
    Rule(
        "library-docs-styles",
        "require",
        r"^\.lib-docs-markdown \{",
        ("src/styles/_library.scss",),
        "the Library document preview must have its scoped reading styles",
        ".lib-docs-markdown {",
    ),
    # The shipped UI is offline-first: fonts are vendored and nothing loads from a remote origin.
    Rule(
        "remote-urls",
        "forbid",
        r"https?://",
        ("index.html", *STYLES),
        "index.html and styles must not reference remote URLs",
        '@import url("https://fonts.example.com/inter.css");',
    ),
    Rule("vendored-font", "require", r"@font-face", STYLES, "the vendored UI font must be declared with @font-face", "@font-face {"),
    Rule(
        "reduced-motion",
        "require",
        r"@media \(prefers-reduced-motion: reduce\)",
        ("src/styles/_tokens.scss",),
        "base styles must honor prefers-reduced-motion",
        "@media (prefers-reduced-motion: reduce) {",
    ),
    # The browser mock backend is dev-only: main.tsx is its single importer and gates it on the dev server.
    Rule(
        "mock-backend-importer",
        "forbid",
        r"dev/mockBackend",
        ("src/",),
        "src/dev/mockBackend must only be imported from src/main.tsx",
        'import { install } from "./dev/mockBackend";',
        exclude=("src/main.tsx", "src/dev/*"),
    ),
    Rule(
        "mock-backend-gate",
        "require",
        r'import\.meta\.env\.DEV.*has\("mock"\)',
        ("src/main.tsx",),
        "main.tsx must gate the mock backend on import.meta.env.DEV and ?mock",
        'if (import.meta.env.DEV && params.has("mock")) {',
    ),
    Rule(
        "mock-backend-dynamic-import",
        "require",
        r'import\("\./dev/mockBackend"\)',
        ("src/main.tsx",),
        "main.tsx must load the mock backend with a dynamic import",
        'await import("./dev/mockBackend");',
    ),
)

Extra = Callable[[Path], list[str]]
GROUPS: dict[str, tuple[tuple[Rule, ...], Extra | None]] = {
    "identity": (IDENTITY, None),
    "tauri-conf": (TAURI_CONF_RULES, tauri_conf),
    "startup-order": ((), startup_order),
    "forbidden": (FORBIDDEN, None),
    "require": (REQUIRE, None),
    "ui": (UI, None),
}
RULES = tuple(rule for rules, _ in GROUPS.values() for rule in rules)


def run(root: Path, groups: list[str]) -> list[str]:
    files = iter_files(root)
    failures = []
    for name in groups:
        rules, extra = GROUPS[name]
        failures += [f"[{name}] {message}" for message in check(root, rules, files)]
        if extra is not None:
            failures += [f"[{name}] {message}" for message in extra(root)]
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--group", action="append", default=[], help="comma-separated group names")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    groups = [name for value in args.group for name in value.split(",") if name] or list(GROUPS)
    unknown = sorted(set(groups) - set(GROUPS))
    if unknown:
        parser.error(f"unknown group(s) {unknown}; known: {', '.join(GROUPS)}")
    failures = run(args.root.resolve(), groups)
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"  source checks passed: {', '.join(groups)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
