import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyMarkdownHref,
  isSafeExternalMarkdownHref,
} from "../src/lib/markdownLinks";

assert.equal(classifyMarkdownHref("https://example.com/docs"), "external");
assert.equal(classifyMarkdownHref("http://example.com"), "external");
assert.equal(classifyMarkdownHref("#section"), "anchor");
assert.equal(classifyMarkdownHref("javascript:alert(1)"), "blocked");
assert.equal(classifyMarkdownHref("data:text/html,hi"), "blocked");
assert.equal(classifyMarkdownHref("file:///etc/passwd"), "blocked");
assert.equal(classifyMarkdownHref("/etc/passwd"), "blocked");
assert.equal(classifyMarkdownHref("../secrets.md"), "blocked");
assert.equal(classifyMarkdownHref("docs/README.md"), "blocked");
assert.equal(classifyMarkdownHref("ftp://example.com"), "blocked");
assert.equal(isSafeExternalMarkdownHref("https://ok.test"), true);
assert.equal(isSafeExternalMarkdownHref("javascript:void(0)"), false);

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(
  join(here, "../src/tools/repoDashboard/MarkdownRenderer.tsx"),
  "utf8",
);
const sharedRendererSource = readFileSync(
  join(here, "../src/components/SafeMarkdown.tsx"),
  "utf8",
);
assert.ok(!sharedRendererSource.includes("rehype-raw"), "markdown renderer must not allow raw HTML");
assert.ok(
  sharedRendererSource.includes("remarkGfm") || rendererSource.includes("remarkGfm"),
  "markdown renderer uses GFM plugin",
);
assert.ok(rendererSource.includes("SafeMarkdown"), "repo dashboard markdown delegates to shared renderer");

console.log("Repo Dashboard markdown safety checks passed");
