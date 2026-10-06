import { describe, expect, it } from "vitest";
import { buildBrainSetupBlock } from "./brainSetup";

const EXPECTED_SKILLS = [
  "accessibility-review",
  "browser-qa",
  "context-budget",
  "current-docs",
  "database-migrations",
  "diagnose",
  "frontend-design",
  "handoff",
  "implementation-plan",
  "kretsverket-editor-change",
  "kretsverket-electrical-drawing",
  "kretsverket-file-compatibility",
  "kretsverket-symbol-system",
  "minimal-implementation",
  "prototype",
  "release-check",
  "retro",
  "screenshot-review",
  "security-review",
  "tdd",
  "wordpress-woocommerce",
  "zoom-out",
] as const;

const REMOVED_SKILLS = [
  "agent-report-review",
  "caveman",
  "dependency-evaluation",
  "grill-me",
  "grill-with-docs",
  "improve-codebase-architecture",
  "nextjs-product-slice",
  "supabase-rls-review",
  "to-prd",
  "triage",
  "woocommerce-pdp-review",
  "write-a-skill",
] as const;

describe("buildBrainSetupBlock", () => {
  it("represents all 22 expected skill names", () => {
    const block = buildBrainSetupBlock();
    for (const skill of EXPECTED_SKILLS) {
      expect(block).toContain(`${skill}:`);
    }
  });

  it("does not reference removed skill names", () => {
    const block = buildBrainSetupBlock();
    for (const skill of REMOVED_SKILLS) {
      expect(block).not.toContain(skill);
    }
  });

  it("includes minimal-implementation as default quality filter", () => {
    const block = buildBrainSetupBlock();
    expect(block).toContain("minimal-implementation");
    expect(block).toContain("Default code quality filter");
  });

  it("describes handoff for executor report review", () => {
    const block = buildBrainSetupBlock();
    expect(block).toContain("handoff");
    expect(block).toContain("executor report review");
    expect(block).not.toContain("agent-report-review");
  });

  it("describes grouped source layout and flat installed layout", () => {
    const block = buildBrainSetupBlock();
    expect(block).toContain("grouped one level");
    expect(block).toContain("Installed harness skills remain flat");
  });

  it("does not describe skill profiles", () => {
    const block = buildBrainSetupBlock();
    expect(block).toContain("no skill profiles");
    expect(block).not.toMatch(/\b(complete|general|kretsverket|wordpress) profile\b/i);
  });
});
