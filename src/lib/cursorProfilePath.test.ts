import { describe, expect, it } from "vitest";
import { cursorProfilePathValidationError } from "./cursorProfilePath";

describe("cursorProfilePathValidationError", () => {
  it("rejects Cursor executable-like paths", () => {
    const path = String.raw`C:\Users\me\AppData\Local\Programs\cursor\resources\app\bin\cursor`;
    expect(cursorProfilePathValidationError(path)).toContain("CLI/program path");
  });

  it("accepts empty custom path", () => {
    expect(cursorProfilePathValidationError("")).toBeNull();
  });

  it("rejects Cursor app bin directory", () => {
    const path = String.raw`C:\Users\me\AppData\Local\Programs\cursor\resources\app\bin`;
    expect(cursorProfilePathValidationError(path)).toContain("CLI/program path");
  });

  it("accepts custom profile root on another drive", () => {
    expect(cursorProfilePathValidationError(String.raw`D:\AgentWorkspace\cursor-profile`)).toBeNull();
  });
});
