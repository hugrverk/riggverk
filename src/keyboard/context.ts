import { createContext, useContext, useSyncExternalStore } from "react";
import { CommandRegistry } from "./commands/registry";
import type { CommandSpec } from "./commands/parser";
import { detectPlatform, type Platform } from "./keymap";
import { KeymapRegistry, type RegisteredBinding } from "./registry";

export interface KeymapContextValue {
  keymap: KeymapRegistry;
  commands: CommandRegistry;
  platform: Platform;
}

/** Changes on every focus move or chord step, so it lives apart from the stable registry context. */
export interface KeymapState {
  /** Display tokens of the chord typed so far ("g"), empty when idle. */
  pendingChord: string[];
  /** `data-pane-id` of the pane that holds focus. */
  activePaneId: string | null;
  /** True while a text field has focus (INSERT mode). */
  editing: boolean;
  /** True while focus is inside a listbox. */
  inList: boolean;
}

export const IDLE_KEYMAP_STATE: KeymapState = { pendingChord: [], activePaneId: null, editing: false, inList: false };

export const KeymapContext = createContext<KeymapContextValue | null>(null);
export const KeymapStateContext = createContext<KeymapState>(IDLE_KEYMAP_STATE);

// Components that read the registries still call the same hooks without a provider.
const DETACHED_KEYMAP = new KeymapRegistry();
const DETACHED_COMMANDS = new CommandRegistry();

export function useKeymapContext(): KeymapContextValue | null {
  return useContext(KeymapContext);
}

export function useKeymapState(): KeymapState {
  return useContext(KeymapStateContext);
}

export function usePlatform(): Platform {
  return useContext(KeymapContext)?.platform ?? detectPlatform();
}

/** Live list of every registered binding (re-renders when bindings change). */
export function useKeymapEntries(): readonly RegisteredBinding[] {
  const registry = useContext(KeymapContext)?.keymap ?? DETACHED_KEYMAP;
  return useSyncExternalStore(registry.subscribe, registry.entries);
}

/** Live list of every registered command. */
export function useCommandList(): readonly CommandSpec[] {
  const registry = useContext(KeymapContext)?.commands ?? DETACHED_COMMANDS;
  return useSyncExternalStore(registry.subscribe, registry.commands);
}
