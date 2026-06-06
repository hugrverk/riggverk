import { describe, expect, it } from "vitest";
import { isEditableEventTarget } from "./isEditableEventTarget";

describe("isEditableEventTarget", () => {
  it("returns true for textarea, input, select, and contenteditable", () => {
    expect(isEditableEventTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableEventTarget(document.createElement("input"))).toBe(true);
    expect(isEditableEventTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isEditableEventTarget(editable)).toBe(true);
  });

  it("returns false for non-editable elements", () => {
    expect(isEditableEventTarget(document.createElement("button"))).toBe(false);
    expect(isEditableEventTarget(document.createElement("div"))).toBe(false);
    expect(isEditableEventTarget(null)).toBe(false);
  });
});
