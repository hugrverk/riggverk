import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isEditableEventTarget } from "../lib/isEditableEventTarget";
import { CommandRegistry } from "./commands/registry";
import {
  IDLE_KEYMAP_STATE,
  KeymapContext,
  KeymapStateContext,
  type KeymapContextValue,
  type KeymapState,
} from "./context";
import { collectCandidates, isNativeActivator } from "./dispatch";
import { paneIdOf } from "./focus";
import {
  CHORD_TIMEOUT_MS,
  detectPlatform,
  isAllowedModCombo,
  isModifierKey,
  matchesPrefix,
  type KeyEventLike,
  type Platform,
} from "./keymap";
import { evaluateWhen, KeymapRegistry, type RegisteredBinding } from "./registry";

interface KeymapProviderProps {
  children: ReactNode;
  /** Override platform detection (tests). */
  platform?: Platform;
  /** Chord buffer lifetime; defaults to 800ms. */
  chordTimeoutMs?: number;
}

function snapshotEvent(event: KeyboardEvent): KeyEventLike {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

function sameState(a: KeymapState, b: KeymapState): boolean {
  return (
    a.activePaneId === b.activePaneId
    && a.editing === b.editing
    && a.inList === b.inList
    && a.pendingChord.length === b.pendingChord.length
    && a.pendingChord.every((token, index) => token === b.pendingChord[index])
  );
}

/**
 * Owns the single window keydown listener. A key is ignored when: another handler already
 * called preventDefault, an IME is composing, Alt is held, Cmd/Ctrl is held on anything but
 * Mod+s / Mod+k / Mod+, , the target is a native activator and the key is Enter/Space, the
 * target is a text field and the binding lacks `inEditable`, or a dialog/overlay is open and the
 * binding is not overlay-scoped. Otherwise bindings are walked innermost scope first and the first
 * handler that does not return false wins and gets preventDefault.
 */
export function KeymapProvider({ children, platform: platformOverride, chordTimeoutMs = CHORD_TIMEOUT_MS }: KeymapProviderProps) {
  const [registries] = useState(() => ({ keymap: new KeymapRegistry(), commands: new CommandRegistry() }));
  const platform = useMemo(() => platformOverride ?? detectPlatform(), [platformOverride]);
  const [state, setState] = useState<KeymapState>(IDLE_KEYMAP_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const contextValue = useMemo<KeymapContextValue>(
    () => ({ keymap: registries.keymap, commands: registries.commands, platform }),
    [registries, platform],
  );

  useEffect(() => {
    const { keymap } = registries;
    let buffer: KeyEventLike[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const patchState = (patch: Partial<KeymapState>) => {
      const next = { ...stateRef.current, ...patch };
      if (sameState(next, stateRef.current)) return;
      stateRef.current = next;
      setState(next);
    };

    const setBuffer = (next: KeyEventLike[]) => {
      buffer = next;
      if (timer) clearTimeout(timer);
      timer = null;
      if (next.length > 0) {
        timer = setTimeout(() => {
          buffer = [];
          timer = null;
          patchState({ pendingChord: [] });
        }, chordTimeoutMs);
      }
      patchState({ pendingChord: next.map(event => event.key) });
    };

    const evaluate = (usable: readonly RegisteredBinding[], seq: readonly KeyEventLike[], event: KeyboardEvent) => {
      const exact: RegisteredBinding[] = [];
      let partial = false;
      for (const entry of usable) {
        for (const chord of entry.chords) {
          if (!matchesPrefix(chord, seq, platform)) continue;
          if (chord.length === seq.length) {
            if (!exact.includes(entry)) exact.push(entry);
          } else {
            partial = true;
          }
        }
      }
      for (const entry of exact) {
        if (entry.binding.run(event) !== false) {
          event.preventDefault();
          return { handled: true, pending: false };
        }
      }
      return { handled: false, pending: partial };
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.altKey || isModifierKey(event.key)) return;
      if ((event.metaKey || event.ctrlKey) && !isAllowedModCombo(event, platform)) return;

      const target = event.target instanceof Element ? event.target : null;
      if (target && isNativeActivator(target) && (event.key === "Enter" || event.key === " ")) return;
      const editable = isEditableEventTarget(event.target);

      const { candidates, overlayOnly } = collectCandidates(keymap.entries(), target);
      const usable = candidates.filter(entry => {
        const { binding } = entry;
        if (overlayOnly && binding.scope !== "overlay") return false;
        if (editable && !binding.inEditable) return false;
        if (event.repeat && !binding.repeat) return false;
        return evaluateWhen(binding).active;
      });

      let seq = [...buffer, snapshotEvent(event)];
      let result = evaluate(usable, seq, event);
      if (!result.handled && !result.pending && buffer.length > 0) {
        // A broken chord drops the buffer and the key gets a fresh start (g then j still moves down).
        setBuffer([]);
        seq = [snapshotEvent(event)];
        result = evaluate(usable, seq, event);
      }
      if (result.handled) {
        if (buffer.length > 0) setBuffer([]);
      } else if (result.pending) {
        setBuffer(seq);
        event.preventDefault();
      }
    };

    const syncFocus = () => {
      const active = document.activeElement;
      patchState({
        activePaneId: paneIdOf(active),
        editing: isEditableEventTarget(active),
        inList: active instanceof Element && active.closest("[role='listbox']") !== null,
      });
    };
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onFocusOut = (event: FocusEvent) => {
      // Focus is moving somewhere else: focusin will report it. A null target means blur()/removal.
      if (event.relatedTarget !== null) return;
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(syncFocus, 0);
    };

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", syncFocus);
    document.addEventListener("focusout", onFocusOut);
    syncFocus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", syncFocus);
      document.removeEventListener("focusout", onFocusOut);
      if (timer) clearTimeout(timer);
      if (blurTimer) clearTimeout(blurTimer);
    };
  }, [registries, platform, chordTimeoutMs]);

  return (
    <KeymapContext.Provider value={contextValue}>
      <KeymapStateContext.Provider value={state}>{children}</KeymapStateContext.Provider>
    </KeymapContext.Provider>
  );
}
