import { describe, expect, it } from "vitest";
import { installationStatus, surfaceStatus } from "../test/pageFixtures";
import type { CodexConfigStatus } from "../types";
import { codexConfigGates, codexConfigModelFor, keepMessage, keyNames, keyValueText, withKeptKeys } from "./codexConfig";

const REVIEWER = { key: "approvals_reviewer", value: "auto_review" };
const SANDBOX = { key: "sandbox_mode", value: "read-only" };
const CONTEXT = { dataFolderOk: true, busyLabel: null, blockedBy: null };

function statusWith(config: CodexConfigStatus | undefined) {
  return installationStatus("current", [{ ...surfaceStatus("codex_config", "current"), ...(config ? { codex_config: config } : {}) }]);
}

describe("codexConfigModelFor", () => {
  it("reads the kept and differing keys of the config surface", () => {
    expect(codexConfigModelFor(statusWith({ kept: [REVIEWER], differing: [SANDBOX] }))).toEqual({ kept: [REVIEWER], differing: [SANDBOX] });
  });

  it("is null without keys, without the surface, or without a status", () => {
    expect(codexConfigModelFor(statusWith(undefined))).toBeNull();
    expect(codexConfigModelFor(statusWith({ kept: [], differing: [] }))).toBeNull();
    expect(codexConfigModelFor(installationStatus("current", [surfaceStatus("codex_rules", "current")]))).toBeNull();
    expect(codexConfigModelFor(null)).toBeNull();
    expect(codexConfigModelFor(undefined)).toBeNull();
  });
});

describe("texts", () => {
  it("lists keys with their values and names", () => {
    expect(keyValueText([REVIEWER, SANDBOX])).toBe("approvals_reviewer = auto_review, sandbox_mode = read-only");
    expect(keyNames([])).toBe("");
    expect(keyNames([REVIEWER])).toBe("approvals_reviewer");
    expect(keyNames([REVIEWER, SANDBOX])).toBe("approvals_reviewer and sandbox_mode");
    expect(keyNames([REVIEWER, SANDBOX, { key: "approval_policy", value: "never" }])).toBe("approvals_reviewer, sandbox_mode and approval_policy");
  });

  it("says plainly what keeping does", () => {
    const message = keepMessage([REVIEWER]);
    expect(message).toContain("approvals_reviewer = auto_review");
    expect(message).toContain("never writes it");
    expect(message).toContain("other managed keys keep following Riggverk");
    expect(keepMessage([REVIEWER, SANDBOX])).toContain("never writes them");
  });
});

describe("withKeptKeys", () => {
  const CURRENT = { glyph: "ok", tone: "ok", label: "current" } as const;

  it("counts the kept keys on the row and no longer reads as plainly current", () => {
    expect(withKeptKeys(CURRENT, { kept: [REVIEWER], differing: [] })).toEqual({ glyph: "partial", tone: "warn", label: "current · you keep 1" });
    expect(withKeptKeys(CURRENT, { kept: [REVIEWER, SANDBOX], differing: [] }).label).toBe("current · you keep 2");
  });

  it("leaves the row alone when nothing is kept", () => {
    expect(withKeptKeys(CURRENT, null)).toBe(CURRENT);
    expect(withKeptKeys(CURRENT, { kept: [], differing: [REVIEWER] })).toBe(CURRENT);
  });
});

describe("codexConfigGates", () => {
  it("offers keep while keys differ, hand back once everything that differs is kept", () => {
    const differing = codexConfigGates({ kept: [], differing: [REVIEWER] }, CONTEXT);
    expect(differing.keep).toEqual({ visible: true, reason: null });
    expect(differing.handBack.visible).toBe(false);

    const kept = codexConfigGates({ kept: [REVIEWER], differing: [] }, CONTEXT);
    expect(kept.keep.visible).toBe(false);
    expect(kept.handBack).toEqual({ visible: true, reason: null });

    // A new key differs while another is kept: keep first (it keeps all of them), hand back after.
    const both = codexConfigGates({ kept: [REVIEWER], differing: [SANDBOX] }, CONTEXT);
    expect(both.keep.visible).toBe(true);
    expect(both.handBack.visible).toBe(false);
  });

  it("offers nothing without a model or with an unusable data folder", () => {
    for (const gates of [codexConfigGates(null, CONTEXT), codexConfigGates({ kept: [REVIEWER], differing: [] }, { ...CONTEXT, dataFolderOk: false })]) {
      expect(gates.keep.visible).toBe(false);
      expect(gates.handBack.visible).toBe(false);
    }
  });

  it("waits for a review or a running task, and says why", () => {
    const model = { kept: [], differing: [REVIEWER] };
    expect(codexConfigGates(model, { ...CONTEXT, blockedBy: "close the install review first" }).keep.reason).toBe("close the install review first");
    expect(codexConfigGates(model, { ...CONTEXT, busyLabel: "update codex" }).keep.reason).toBe("update codex is running");
  });
});
