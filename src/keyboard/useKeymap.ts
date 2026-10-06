import { useContext, useEffect, useRef, type RefObject } from "react";
import { KeymapContext } from "./context";
import { evaluateWhen, type Binding } from "./registry";

export interface UseKeymapOptions {
  /** Live only while the event target is inside this element. */
  ref?: RefObject<HTMLElement | null>;
  /** Register nothing while false. Default true. */
  enabled?: boolean;
}

function signatureOf(binding: Binding): string {
  const keys = typeof binding.keys === "string" ? binding.keys : binding.keys.join("|");
  const state = binding.when ? evaluateWhen(binding) : null;
  const when = state ? `w:${String(state.active)}:${state.disabledReason ?? ""}` : "-";
  return [
    binding.id,
    keys,
    binding.scope,
    binding.paneId ?? "",
    binding.title,
    binding.group ?? "",
    binding.hint ?? "",
    binding.inEditable ? "e" : "",
    binding.repeat ? "r" : "",
    when,
  ].join("\u0000");
}

/**
 * Registers bindings for the lifetime of the calling component. `run` and `when` always read the
 * latest closure, so passing a fresh array every render is fine; the registry is only touched when
 * a binding's identity, keys, label or enabled state changes. Without a KeymapProvider this is a no-op.
 */
export function useKeymap(bindings: readonly Binding[], options: UseKeymapOptions = {}): void {
  const registry = useContext(KeymapContext)?.keymap ?? null;
  const { ref, enabled = true } = options;
  const latest = useRef(bindings);
  latest.current = bindings;
  const signature = enabled ? bindings.map(signatureOf).join("\n") : "";

  useEffect(() => {
    if (!registry || !enabled) return;
    const current = (id: string) => latest.current.find(binding => binding.id === id);
    const proxies = latest.current.map((binding): Binding => ({
      ...binding,
      when: binding.when ? () => current(binding.id)?.when?.() ?? false : undefined,
      run: event => {
        const live = current(binding.id);
        // A binding that vanished between registration and dispatch is "not handled".
        return live ? live.run(event) : false;
      },
    }));
    return registry.registerMany(proxies, ref);
    // `signature` captures every field the proxies copy; `latest` supplies the closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, enabled, signature, ref]);
}
