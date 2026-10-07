#!/usr/bin/env python3
"""Unit checks for the shipped digests generator contract."""

from __future__ import annotations

import importlib.util
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
GENERATOR_PATH = ROOT / "scripts" / "generate-shipped-digests.py"
WORKSPACE = ROOT / "resources/default-workspace"


def load_generator():
    spec = importlib.util.spec_from_file_location("generate_shipped_digests", GENERATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load generator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ShippedDigestsGeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.generator = load_generator()

    def test_file_copy_sources_keep_their_own_path_as_key(self) -> None:
        for rel in (
            "templates/skills/claude/frontend-design/SKILL.md",
            "templates/skills/codex/tdd/SKILL.md",
            "templates/claude/agents/repo-scout.md",
            "templates/cursor/agents/verifier.md",
            "templates/codex/agents/security_reviewer.toml",
            "agents/inspector.md",
            "templates/playwright-mcp.config.json",
        ):
            self.assertEqual(self.generator.source_key(rel), rel)

    def test_generic_and_deprecated_skills_share_a_logical_key(self) -> None:
        for rel in (
            "skills/tdd/SKILL.md",
            "skills/kretsverket/kretsverket-symbol-system/SKILL.md",
            "metadata/deprecated-skills/tdd/SKILL.md",
        ):
            key = self.generator.source_key(rel)
            self.assertRegex(key, r"^skills/[a-z0-9-]+/SKILL\.md$")
        self.assertEqual(
            self.generator.source_key("skills/kretsverket/kretsverket-symbol-system/SKILL.md"),
            "skills/kretsverket-symbol-system/SKILL.md",
        )

    def test_out_of_scope_paths_have_no_key(self) -> None:
        for rel in (
            "templates/sync/claude-rules.md",
            "templates/opencode.json",
            "templates/codex/config.toml",
            "templates/cursor/mcp/playwright.mcp.json",
            "templates/claude/agents/inspector.header.yaml",
            "templates/skills/unknown/tdd/SKILL.md",
            "skills/a/b/c/SKILL.md",
            "docs/GUIDE.md",
            "agents/README.md",
        ):
            self.assertIsNone(self.generator.source_key(rel), rel)

    def test_binary_empty_and_oversized_content_is_skipped(self) -> None:
        self.assertTrue(self.generator.usable_text(b"# skill\n"))
        self.assertFalse(self.generator.usable_text(b""))
        self.assertFalse(self.generator.usable_text(b"a\0b"))
        self.assertFalse(self.generator.usable_text(b"\xff\xfe"))
        self.assertFalse(self.generator.usable_text(b"a" * (self.generator.MAX_BYTES + 1)))

    def test_digest_matches_the_app_hash_format(self) -> None:
        # setup_fingerprint::hash_file renders `sha256:` plus lowercase hex.
        self.assertEqual(
            self.generator.digest(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )

    def test_encoding_is_sorted_and_newline_terminated(self) -> None:
        text = self.generator.encoded(
            {"schema": 1, "sources": {"b": ["sha256:2"], "a": ["sha256:1"]}}
        )
        self.assertTrue(text.endswith("}\n"))
        self.assertLess(text.index('"a"'), text.index('"b"'))

    def test_bundled_metadata_is_well_formed_and_covers_current_sources(self) -> None:
        metadata = json.loads(
            (WORKSPACE / "metadata/shipped-digests.json").read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["schema"], self.generator.SCHEMA)
        sources = metadata["sources"]
        self.assertEqual(list(sources), sorted(sources))
        for key, digests in sources.items():
            self.assertTrue(digests, key)
            self.assertEqual(digests, sorted(set(digests)), key)
            for value in digests:
                self.assertRegex(value, r"^sha256:[0-9a-f]{64}$", key)
        # The working-tree version of every bundled source is a shipped version.
        covered = 0
        for path in sorted(WORKSPACE.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            key = self.generator.source_key(path.relative_to(WORKSPACE).as_posix())
            raw = path.read_bytes()
            if key is None or not self.generator.usable_text(raw):
                continue
            self.assertIn(self.generator.digest(raw), sources.get(key, []), key)
            covered += 1
        self.assertGreater(covered, 0)
        self.assertTrue(
            any(re.match(r"^templates/skills/claude/", key) for key in sources),
            "adapter skill history must be present",
        )


if __name__ == "__main__":
    unittest.main()
