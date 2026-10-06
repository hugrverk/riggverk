/** Input types that accept typed characters. Radio, checkbox, range, color, file and button-like types are not editable. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

function isContentEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const attr = el.closest("[contenteditable]")?.getAttribute("contenteditable");
  return attr !== undefined && attr !== null && attr.toLowerCase() !== "false";
}

/** True when keyboard shortcuts should defer to native text entry or select behaviour. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (isContentEditable(target)) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
  const role = target.getAttribute("role");
  return role === "textbox" || role === "combobox";
}
