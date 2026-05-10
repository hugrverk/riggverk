/**
 * designMdRenderEligibility.test.ts
 *
 * Unit tests for the render eligibility model.
 * Run with: npx tsx src/lib/designMdRenderEligibility.test.ts
 */

import { checkRenderEligibility } from "./designMdRenderEligibility";
import type { DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${label} — expected "${expected}", got "${actual}"`);
  }
}

function makeComponent(overrides: Partial<DesignMdBoardComponentGroup> = {}): DesignMdBoardComponentGroup {
  return {
    name: "test-card",
    kind: "card",
    backgroundColor: undefined,
    textColor: undefined,
    borderColor: undefined,
    rounded: undefined,
    padding: undefined,
    styles: {},
    raw: {},
    source: "structured",
    sourceEvidence: { sourceType: "frontmatter", sourcePath: "components.test-card", confidence: "high", text: "test-card" },
    ...overrides,
  };
}

// ── Test: generic component cannot render graphically ──
{
  const comp = makeComponent({ name: "some-generic", kind: "generic" });
  const result = checkRenderEligibility(comp);
  assert(!result.canRenderGraphic, "generic component should not render graphically");
  assert(result.canRenderCompact, "generic component should render compact");
  assert(result.reason.includes("generic"), "reason should mention generic restriction");
}

// ── Test: button with source styles renders graphically ──
{
  const comp = makeComponent({
    name: "button-primary",
    kind: "button",
    backgroundColor: "#0066cc",
    textColor: "#ffffff",
    rounded: "8px",
    styles: { backgroundColor: "#0066cc", textColor: "#ffffff", rounded: "8px" },
    raw: { backgroundColor: "#0066cc", textColor: "#ffffff", rounded: "8px" },
  });
  const result = checkRenderEligibility(comp);
  assert(result.canRenderGraphic, "button with bg+text should render graphically");
  assertEqual(result.confidence, "high", "well-sourced button should have high confidence");
}

// ── Test: card without styles cannot render graphically ──
{
  const comp = makeComponent({
    name: "empty-card",
    kind: "card",
    backgroundColor: undefined,
    textColor: undefined,
    source: "markdown",
    sourceEvidence: { sourceType: "markdown-heading", sourcePath: "markdown.Components.empty-card", confidence: "medium", text: "empty-card" },
  });
  const result = checkRenderEligibility(comp);
  assert(!result.canRenderGraphic, "card without bg or border should not render graphically");
  assert(result.canRenderCompact, "card without styles should still render compact");
}

// ── Test: fallback-only component cannot render graphically ──
{
  const comp = makeComponent({
    name: "inferred-card",
    kind: "card",
    sourceEvidence: { sourceType: "derived-fallback", sourcePath: "components.inferred-card", confidence: "fallback", text: "inferred" },
  });
  const result = checkRenderEligibility(comp);
  assert(!result.canRenderGraphic, "fallback-only component should not render graphically");
}

// ── Test: poor contrast component is downgraded ──
{
  const comp = makeComponent({
    name: "bad-contrast",
    kind: "card",
    backgroundColor: "#ffffff",
    textColor: "#fefefe",
    sourceEvidence: { sourceType: "frontmatter", sourcePath: "components.bad-contrast", confidence: "medium", text: "bad-contrast" },
  });
  const result = checkRenderEligibility(comp);
  assert(!result.canRenderGraphic, "poor contrast component should not render graphically");
  assert(result.reason.includes("contrast"), "reason should mention contrast");
}

// ── Test: component with border but no bg can render ──
{
  const comp = makeComponent({
    name: "bordered-card",
    kind: "card",
    backgroundColor: undefined,
    textColor: "#111111",
    borderColor: "#cccccc",
    sourceEvidence: { sourceType: "frontmatter", sourcePath: "components.bordered-card", confidence: "high", text: "bordered-card" },
  });
  const result = checkRenderEligibility(comp);
  assert(result.canRenderGraphic, "card with border+text should render graphically even without explicit bg");
}

// ── Test: utility component is always compact ──
{
  const comp = makeComponent({
    name: "configurator-panel",
    kind: "utility",
    backgroundColor: "#eeeeee",
    textColor: "#111111",
    sourceEvidence: { sourceType: "frontmatter", sourcePath: "components.configurator-panel", confidence: "high", text: "configurator-panel" },
  });
  const result = checkRenderEligibility(comp);
  assert(!result.canRenderGraphic, "utility component should always render compact");
}

// ── Test: missing name renders nothing ──
{
  const comp = makeComponent({
    name: "",
    kind: "card",
  });
  const result = checkRenderEligibility(comp);
  assert(!result.canRenderGraphic, "nameless component should not render graphically");
  assert(!result.canRenderCompact, "nameless component should not render at all");
}

// ── Test: chip with bg renders graphically ──
{
  const comp = makeComponent({
    name: "status-pill",
    kind: "chip",
    backgroundColor: "#10b981",
    textColor: "#ffffff",
    sourceEvidence: { sourceType: "frontmatter", sourcePath: "components.status-pill", confidence: "high", text: "status-pill" },
  });
  const result = checkRenderEligibility(comp);
  assert(result.canRenderGraphic, "chip with bg+text should render graphically");
}

// ── Test: nav with valid name renders graphically ──
{
  const comp = makeComponent({
    name: "top-nav",
    kind: "nav",
    sourceEvidence: { sourceType: "markdown-heading", sourcePath: "markdown.Components.top-nav", confidence: "medium", text: "top-nav" },
  });
  const result = checkRenderEligibility(comp);
  assert(result.canRenderGraphic, "nav with source evidence should render graphically");
}

// ── Summary ──
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
