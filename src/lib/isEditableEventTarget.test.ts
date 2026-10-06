import { describe, expect, it } from "vitest";
import { isEditableEventTarget } from "./isEditableEventTarget";

function input(type?: string): HTMLInputElement {
  const el = document.createElement("input");
  if (type) el.setAttribute("type", type);
  return el;
}

describe("isEditableEventTarget", () => {
  it("returns true for textarea, text-like inputs, select, and contenteditable", () => {
    expect(isEditableEventTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableEventTarget(input())).toBe(true);
    expect(isEditableEventTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isEditableEventTarget(editable)).toBe(true);
  });

  it.each(["text", "search", "url", "tel", "email", "password", "number", "date", "time"])(
    "treats input type=%s as editable",
    type => {
      expect(isEditableEventTarget(input(type))).toBe(true);
    },
  );

  it.each(["radio", "checkbox", "range", "button", "submit", "color", "file"])(
    "does not treat input type=%s as editable",
    type => {
      expect(isEditableEventTarget(input(type))).toBe(false);
    },
  );

  it("treats role=textbox and role=combobox as editable", () => {
    for (const role of ["textbox", "combobox"]) {
      const el = document.createElement("div");
      el.setAttribute("role", role);
      expect(isEditableEventTarget(el)).toBe(true);
    }
  });

  it("returns true for descendants of a contenteditable host unless an inner host opts out", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    host.append(child);
    expect(isEditableEventTarget(child)).toBe(true);

    const opted = document.createElement("span");
    opted.setAttribute("contenteditable", "false");
    host.append(opted);
    expect(isEditableEventTarget(opted)).toBe(false);
  });

  it("returns false for non-editable elements", () => {
    expect(isEditableEventTarget(document.createElement("button"))).toBe(false);
    expect(isEditableEventTarget(document.createElement("div"))).toBe(false);
    expect(isEditableEventTarget(document.createElement("ul"))).toBe(false);
    expect(isEditableEventTarget(null)).toBe(false);
  });
});
