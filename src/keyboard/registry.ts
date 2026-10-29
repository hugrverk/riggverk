import type { RefObject } from "react";
import { parseKeys, type KeyChord } from "./keymap";

/** Precedence high -> low. */
export type Scope = "overlay" | "editor" | "list" | "pane" | "global";

export const SCOPE_PRECEDENCE: Record<Scope, number> = {
  overlay: 4,
  editor: 3,
  list: 2,
  pane: 1,
  global: 0,
};

export interface Binding {
  /** Registry key, unique per binding instance: "harness.update", "list.codex-targets.next". */
  id: string;
  /** One spec or several alternatives: "j", ["j", "ArrowDown"], "Mod+s", "g g", "Escape". */
  keys: string | readonly string[];
  title: string;
  /** Help-overlay section. Defaults to a label derived from `scope`. */
  group?: string;
  /**
   * Short label. Bindings with a hint render as a button (`BindingButton`) where their owner offers one: while the owning
   * pane (`paneId`) has focus, or always for global bindings.
   */
  hint?: string;
  scope: Scope;
  /** Anchors the binding to `section[data-pane-id=...]`: active only while focus is inside that pane. */
  paneId?: string;
  /** true = enabled, false = inactive (hidden from hints), string = disabled with that reason. */
  when?: () => boolean | string;
  /** Fire while a text field has focus. Default false. */
  inEditable?: boolean;
  /** Fire on auto-repeat. Default false; only navigation (j/k/arrows) opts in. */
  repeat?: boolean;
  /** Return false when the key was not handled so the next binding in the walk can take it. */
  run: (event: KeyboardEvent) => void | false;
}

export interface RegisteredBinding {
  binding: Binding;
  chords: KeyChord[];
  /** When set, the binding is active only while the event target is inside `ref.current`. */
  ref?: RefObject<HTMLElement | null>;
  /** Registration order; breaks ties inside one scope depth. */
  seq: number;
}

interface Slot {
  entry: RegisteredBinding;
  token: symbol;
}

/** Evaluates `when`: undefined means enabled. */
export function evaluateWhen(binding: Binding): { active: boolean; disabledReason: string | null } {
  const result = binding.when ? binding.when() : true;
  if (result === true) return { active: true, disabledReason: null };
  if (result === false) return { active: false, disabledReason: null };
  return { active: false, disabledReason: result };
}

/**
 * Bindings keyed by id. Registering the same id again replaces the previous entry, and a stale
 * disposer never removes a newer registration, so React StrictMode's mount -> cleanup -> mount is
 * idempotent.
 */
export class KeymapRegistry {
  private slots = new Map<string, Slot>();
  private listeners = new Set<() => void>();
  private snapshot: readonly RegisteredBinding[] = [];
  private seq = 0;

  register(binding: Binding, ref?: RefObject<HTMLElement | null>): () => void {
    return this.registerMany([binding], ref);
  }

  registerMany(bindings: readonly Binding[], ref?: RefObject<HTMLElement | null>): () => void {
    const tokens: Array<[string, symbol]> = [];
    for (const binding of bindings) {
      const token = Symbol(binding.id);
      this.slots.set(binding.id, {
        token,
        entry: { binding, chords: parseKeys(binding.keys), ref, seq: this.seq++ },
      });
      tokens.push([binding.id, token]);
    }
    this.rebuild();
    return () => {
      let changed = false;
      for (const [id, token] of tokens) {
        const slot = this.slots.get(id);
        if (slot && slot.token === token) {
          this.slots.delete(id);
          changed = true;
        }
      }
      if (changed) this.rebuild();
    };
  }

  /** Stable between changes (safe as a useSyncExternalStore snapshot). */
  entries = (): readonly RegisteredBinding[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private rebuild() {
    this.snapshot = [...this.slots.values()].map(slot => slot.entry).sort((a, b) => a.seq - b.seq);
    for (const listener of [...this.listeners]) listener();
  }
}

/** A hinted binding shows unless `when()` is false; a `when()` reason string shows it disabled. */
export function isVisibleHint(entry: RegisteredBinding): boolean {
  if (!entry.binding.hint) return false;
  const { active, disabledReason } = evaluateWhen(entry.binding);
  return active || disabledReason !== null;
}

/** Bindings anchored to the pane that carry a hint. */
export function paneHintEntries(entries: readonly RegisteredBinding[], paneId: string): RegisteredBinding[] {
  return entries.filter(entry => entry.binding.paneId === paneId && entry.binding.hint);
}

const SCOPE_GROUP_LABEL: Record<Scope, string> = {
  overlay: "Overlay",
  editor: "Editor",
  list: "Lists",
  pane: "Pane",
  global: "General",
};

export function bindingGroup(binding: Binding): string {
  return binding.group ?? SCOPE_GROUP_LABEL[binding.scope];
}
