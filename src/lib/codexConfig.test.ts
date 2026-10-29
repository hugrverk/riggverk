import { describe, expect, it } from "vitest";
import { installationStatus, surfaceStatus } from "../test/pageFixtures";
import type { CodexConfigStatus } from "../types";
import { CODEX_MANAGED_KEYS, codexConfigGates, codexConfigModelFor, codexKeyRows, codexWhy, keepMessage, keyNames, keyValueText } from "./codexConfig";

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

describe("codexConfigModelFor with Riggverk's values", () => {
  it("carries the expected values when the backend sends them, and leaves them out for an older backend", () => {
    const expected = [{ key: "approvals_reviewer", value: "user" }];
    expect(codexConfigModelFor(statusWith({ kept: [], differing: [REVIEWER], expected }))?.expected).toEqual(expected);
    expect(codexConfigModelFor(statusWith({ kept: [], differing: [REVIEWER] }))?.expected).toBeUndefined();
  });
});

describe("codexKeyRows", () => {
  const expected = [{ key: "approvals_reviewer", value: "user" }];

  it("lists the differing key with both values first, and the other managed keys as following Riggverk", () => {
    const rows = codexKeyRows({ kept: [], differing: [REVIEWER], expected });
    expect(rows[0]).toEqual({ key: "approvals_reviewer", riggverk: "user", yours: "auto_review", state: "differs" });
    expect(rows.slice(1).every(row => row.state === "same" && row.yours === null && row.riggverk === null)).toBe(true);
    expect(rows.map(row => row.key).sort()).toEqual([...CODEX_MANAGED_KEYS].sort());
  });

  it("shows a kept key as kept with Riggverk's value beside it, between differing and matching keys", () => {
    const rows = codexKeyRows({ kept: [REVIEWER], differing: [SANDBOX], expected });
    expect(rows.map(row => [row.key, row.state])).toEqual([
      ["sandbox_mode", "differs"],
      ["approvals_reviewer", "kept"],
      ["approval_policy", "same"],
      ["apps._default.approvals_reviewer", "same"],
      ["apps._default.default_tools_approval_mode", "same"],
    ]);
    expect(rows[1]).toMatchObject({ riggverk: "user", yours: "auto_review" });
    // Without expected values Riggverk's column is simply not known.
    expect(codexKeyRows({ kept: [], differing: [SANDBOX] })[0]).toMatchObject({ riggverk: null, yours: "read-only" });
  });

  it("shows a key the backend names twice once", () => {
    expect(codexKeyRows({ kept: [REVIEWER], differing: [REVIEWER] }).filter(row => row.key === "approvals_reviewer")).toHaveLength(1);
  });
});

describe("codexWhy", () => {
  it("counts the keys that differ, and tells what is kept once nothing differs", () => {
    expect(codexWhy({ kept: [], differing: [REVIEWER] })).toBe("Riggverk manages 5 keys in this file. One differs from Riggverk's default, so it changed nothing. Codex runs with your values.");
    expect(codexWhy({ kept: [], differing: [REVIEWER, SANDBOX] })).toContain("2 differ from Riggverk's default");
    expect(codexWhy({ kept: [REVIEWER], differing: [] })).toBe("You keep approvals_reviewer, so Riggverk never writes it. It manages the other keys as before. Codex runs with your values.");
  });
});

describe("codexConfigGates defaults", () => {
  it("offers Use Riggverk defaults exactly while keys differ, waits like keep, and is hidden otherwise", () => {
    expect(codexConfigGates({ kept: [], differing: [REVIEWER] }, CONTEXT).defaults).toEqual({ visible: true, reason: null });
    expect(codexConfigGates({ kept: [REVIEWER], differing: [] }, CONTEXT).defaults.visible).toBe(false);
    expect(codexConfigGates(null, CONTEXT).defaults.visible).toBe(false);
    expect(codexConfigGates({ kept: [], differing: [REVIEWER] }, { ...CONTEXT, busyLabel: "update codex" }).defaults.reason).toBe("update codex is running");
    expect(codexConfigGates({ kept: [], differing: [REVIEWER] }, { ...CONTEXT, blockedBy: "close the install review first" }).defaults.reason).toBe("close the install review first");
  });
});
