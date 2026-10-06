import { SCOPE_PRECEDENCE, type RegisteredBinding } from "./registry";

const NATIVE_ACTIVATOR_TAGS = new Set(["BUTTON", "A", "SUMMARY", "SELECT"]);
const NATIVE_ACTIVATOR_INPUT_TYPES = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image"]);
const ACTIVATOR_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem"]);

/**
 * Controls whose Enter/Space belongs to the browser (activating a button, following a link, toggling a
 * checkbox). Global bindings must not swallow those keys.
 */
export function isNativeActivator(target: Element): boolean {
  if (NATIVE_ACTIVATOR_TAGS.has(target.tagName)) return true;
  if (target instanceof HTMLInputElement && NATIVE_ACTIVATOR_INPUT_TYPES.has(target.type)) return true;
  const role = target.getAttribute("role");
  return role !== null && ACTIVATOR_ROLES.has(role);
}

function depthOf(el: Element): number {
  let depth = 0;
  for (let node = el.parentElement; node; node = node.parentElement) depth++;
  return depth;
}

/** `[data-keyscope]` ancestors of the target, innermost first (the target itself included). */
export function keyscopeChain(target: Element | null): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let el: HTMLElement | null = target ? target.closest<HTMLElement>("[data-keyscope]") : null;
  while (el) {
    chain.push(el);
    el = el.parentElement ? el.parentElement.closest<HTMLElement>("[data-keyscope]") : null;
  }
  return chain;
}

function paneAncestor(target: Element | null, paneId: string): HTMLElement | null {
  let pane: HTMLElement | null = target ? target.closest<HTMLElement>("[data-pane-id]") : null;
  while (pane && pane.dataset.paneId !== paneId) {
    pane = pane.parentElement ? pane.parentElement.closest<HTMLElement>("[data-pane-id]") : null;
  }
  return pane;
}

/** The element a binding is attached to for this target: an ancestor, "global", or null when it does not apply. */
function attachElement(
  entry: RegisteredBinding,
  target: Element | null,
  chain: readonly HTMLElement[],
): Element | "global" | null {
  const { binding, ref } = entry;
  if (ref) {
    const host = ref.current;
    return host && target && host.contains(target) ? host : null;
  }
  if (binding.paneId) return paneAncestor(target, binding.paneId);
  if (binding.scope === "global") return "global";
  return chain.find(el => el.dataset.keyscope === binding.scope) ?? null;
}

export interface CandidateSet {
  /** Applicable bindings, innermost scope first, ties by scope precedence then registration order. */
  candidates: RegisteredBinding[];
  /** An overlay or modal dialog owns the keyboard: only overlay-scope bindings may fire. */
  overlayOnly: boolean;
}

/**
 * Scope walk: bindings attached to an ancestor of the target (found through `closest('[data-keyscope]')`,
 * `data-pane-id` or an explicit ref), deepest attachment first, then global bindings.
 */
export function collectCandidates(entries: readonly RegisteredBinding[], target: Element | null): CandidateSet {
  const chain = keyscopeChain(target);
  const ranked: Array<{ entry: RegisteredBinding; depth: number }> = [];
  for (const entry of entries) {
    const attached = attachElement(entry, target, chain);
    if (attached === null) continue;
    ranked.push({ entry, depth: attached === "global" ? -1 : depthOf(attached) });
  }
  ranked.sort(
    (a, b) =>
      b.depth - a.depth
      || SCOPE_PRECEDENCE[b.entry.binding.scope] - SCOPE_PRECEDENCE[a.entry.binding.scope]
      || a.entry.seq - b.entry.seq,
  );
  const overlayOnly =
    chain.some(el => el.dataset.keyscope === "overlay")
    || (target !== null && target.closest("dialog[open]") !== null)
    || document.querySelector("dialog[open]") !== null;
  return { candidates: ranked.map(item => item.entry), overlayOnly };
}
