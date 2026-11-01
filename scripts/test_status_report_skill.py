#!/usr/bin/env python3
"""The status-report skill renders its sample to a report that passes its own verifier, and the
verifier fails on a leaked secret, a missing cite, a date outside the period and an external script."""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "resources/default-workspace/skills/status-report"
RENDER = SKILL / "scripts/render-report.mjs"
VERIFY = SKILL / "scripts/verify-report.mjs"
SAMPLE = ROOT / "scripts/fixtures/status-report-sample.json"
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is required")
class StatusReportSkillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="status-report-test-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.sample = json.loads(SAMPLE.read_text(encoding="utf-8"))

    def node(self, script: Path, *args: str) -> subprocess.CompletedProcess[str]:
        # No --playwright-dir, so the browser pass is skipped whatever the current directory holds.
        return subprocess.run(
            [NODE, str(script), *args], cwd=self.tmp, capture_output=True, text=True, timeout=60, check=False
        )

    def render(self, report: dict, name: str = "report") -> tuple[Path, Path]:
        data = self.tmp / f"{name}.json"
        html = self.tmp / f"{name}.html"
        data.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        result = self.node(RENDER, str(data), "--out", str(html))
        self.assertEqual(result.returncode, 0, result.stderr)
        return data, html

    def verify(self, data: Path, html: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self.node(VERIFY, str(data), *([str(html)] if html else []), "--no-browser")

    def assert_fails(self, result: subprocess.CompletedProcess[str], message: str) -> None:
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)

    def test_sample_renders_and_passes(self) -> None:
        data, html = self.render(self.sample)
        result = self.verify(data, html)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS", result.stdout)
        page = html.read_text(encoding="utf-8")
        self.assertIn('<html lang="en"', page)
        for label in ("Happened", "In progress", "Not checked", "Status: on track"):
            self.assertIn(label, page)
        self.assertNotIn("Lägesrapport", page)
        self.assertNotIn("{{", page)

    def test_swedish_labels_follow_the_language(self) -> None:
        report = copy.deepcopy(self.sample)
        report["project"]["language"] = "sv"
        data, html = self.render(report, "sv")
        result = self.verify(data, html)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        page = html.read_text(encoding="utf-8")
        self.assertIn('<html lang="sv"', page)
        for label in ("Ej kontrollerat", "uppgivet", "Lägesrapport"):
            self.assertIn(label, page)

    def test_secret_pattern_fails_without_printing_it(self) -> None:
        report = copy.deepcopy(self.sample)
        token = "gh" + "p_" + "A1b2C3d4" * 5  # built here so this file holds no token-shaped literal
        report["happened"][0]["detail"] = f"Rotated {token}"
        data, _ = self.render(report)
        result = self.verify(data)
        self.assert_fails(result, "GitHub token pattern")
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_missing_cite_fails(self) -> None:
        report = copy.deepcopy(self.sample)
        report["next"][0]["cite"] = ["nowhere"]
        data, _ = self.render(report)
        self.assert_fails(self.verify(data), "next[0] cites unknown source nowhere")

    def test_date_outside_the_period_fails(self) -> None:
        report = copy.deepcopy(self.sample)
        report["happened"][0]["date"] = "2026-11-02"
        data, _ = self.render(report)
        self.assert_fails(self.verify(data), "happened[0] date 2026-11-02 is outside")

    def test_external_script_fails(self) -> None:
        data, html = self.render(self.sample)
        page = html.read_text(encoding="utf-8")
        html.write_text(page.replace("</head>", '<script src="https://cdn.example.com/x.js"></script></head>'), encoding="utf-8")
        self.assert_fails(self.verify(data, html), "loads https://cdn.example.com/x.js")

    def fake_playwright(self, root: Path, marker: Path) -> None:
        package = root / "node_modules/playwright"
        package.mkdir(parents=True)
        (package / "package.json").write_text('{"name":"playwright","main":"index.js"}', encoding="utf-8")
        (package / "index.js").write_text(
            f"require('fs').writeFileSync({json.dumps(str(marker))}, 'imported');\n"
            "module.exports = { chromium: { launch: async () => { throw new Error('no browser'); } } };\n",
            encoding="utf-8",
        )

    def test_browser_pass_never_imports_playwright_from_the_current_directory(self) -> None:
        marker = self.tmp / "imported-from-cwd"
        self.fake_playwright(self.tmp, marker)
        data, html = self.render(self.sample)
        result = self.node(VERIFY, str(data), str(html))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("SKIP browser pass skipped", result.stdout)
        self.assertFalse(marker.exists(), "a playwright package in the current directory was imported")

    def test_browser_pass_loads_playwright_only_from_the_given_directory(self) -> None:
        approved = self.tmp / "approved"
        marker = self.tmp / "imported-from-approved"
        self.fake_playwright(approved, marker)
        data, html = self.render(self.sample)
        result = self.node(VERIFY, str(data), str(html), f"--playwright-dir={approved}")
        self.assertTrue(marker.exists(), result.stdout + result.stderr)
        self.assertIn("Chromium did not start", result.stdout)

    def test_playwright_dir_does_not_reach_a_parent_node_modules(self) -> None:
        marker = self.tmp / "imported-from-parent"
        self.fake_playwright(self.tmp, marker)
        child = self.tmp / "child"
        child.mkdir()
        data, html = self.render(self.sample)
        result = self.node(VERIFY, str(data), str(html), f"--playwright-dir={child}")
        self.assertFalse(marker.exists(), "a parent directory's playwright was imported")
        self.assertIn("SKIP browser pass skipped", result.stdout)


if __name__ == "__main__":
    unittest.main()
