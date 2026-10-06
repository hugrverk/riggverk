import type { CommandSpec } from "./parser";

interface Slot {
  command: CommandSpec;
  token: symbol;
}

/**
 * Commands keyed by canonical name. Like the keymap registry, re-registering a name replaces the
 * old entry and a stale disposer never removes a newer one (StrictMode-safe).
 */
export class CommandRegistry {
  private slots = new Map<string, Slot>();
  private listeners = new Set<() => void>();
  private snapshot: readonly CommandSpec[] = [];

  register(commands: readonly CommandSpec[]): () => void {
    const tokens: Array<[string, symbol]> = [];
    for (const command of commands) {
      const token = Symbol(command.name);
      this.slots.set(command.name, { command, token });
      tokens.push([command.name, token]);
    }
    this.rebuild();
    return () => {
      let changed = false;
      for (const [name, token] of tokens) {
        const slot = this.slots.get(name);
        if (slot && slot.token === token) {
          this.slots.delete(name);
          changed = true;
        }
      }
      if (changed) this.rebuild();
    };
  }

  /** Stable between changes (safe as a useSyncExternalStore snapshot). */
  commands = (): readonly CommandSpec[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private rebuild() {
    this.snapshot = [...this.slots.values()].map(slot => slot.command);
    for (const listener of [...this.listeners]) listener();
  }
}
