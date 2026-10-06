import { blurToPane, focusPane } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { isEditableEventTarget } from "../lib/isEditableEventTarget";
import { useShellState } from "./ShellState";
import type { ViewDef } from "./views";

interface ShellBindingsOptions {
  tabs: readonly ViewDef[];
  /** Navigates through the app's single switchView path (dirty guards, per-view loading, refocus). */
  goTo: (view: ViewDef["id"]) => void;
  /** An error line is showing and Escape may dismiss it. */
  hasError: boolean;
  onDismissError: () => void;
}

/**
 * The global key layer: 1-9 positional tabs, h/l pane focus, `:` and Mod+k command line, `?` help,
 * Mod+, settings, Escape (leave a text field; otherwise dismiss the error line).
 */
export function useShellBindings({ tabs, goTo, hasError, onDismissError }: ShellBindingsOptions): void {
  const { openCommandLine, openHelp } = useShellState();

  const bindings: Binding[] = [
    ...tabs.slice(0, 9).map((def, index): Binding => ({
      id: `shell.view.${index + 1}`,
      keys: String(index + 1),
      title: `Go to ${def.label}`,
      group: "Navigate",
      scope: "global",
      run: () => goTo(def.id),
    })),
    {
      id: "shell.pane.prev",
      keys: "h",
      title: "Focus previous pane",
      group: "Navigate",
      scope: "global",
      run: () => (focusPane("prev") ? undefined : false),
    },
    {
      id: "shell.pane.next",
      keys: "l",
      title: "Focus next pane",
      group: "Navigate",
      scope: "global",
      run: () => (focusPane("next") ? undefined : false),
    },
    {
      id: "shell.settings",
      keys: "Mod+,",
      title: "Open settings",
      group: "Navigate",
      scope: "global",
      inEditable: true,
      run: () => goTo("settings"),
    },
    {
      id: "shell.command",
      keys: ":",
      title: "Command line",
      hint: "command",
      group: "General",
      scope: "global",
      run: () => openCommandLine(),
    },
    {
      id: "shell.command.palette",
      keys: "Mod+k",
      title: "Command line",
      group: "General",
      scope: "global",
      inEditable: true,
      run: () => openCommandLine(),
    },
    {
      id: "shell.help",
      keys: "?",
      title: "Keyboard help",
      hint: "help",
      group: "General",
      scope: "global",
      run: () => openHelp(),
    },
    {
      id: "shell.escape",
      keys: "Escape",
      title: "Leave text field, dismiss error",
      group: "General",
      scope: "global",
      inEditable: true,
      run: event => {
        const target = event.target instanceof Element ? event.target : document.activeElement;
        if (isEditableEventTarget(target)) {
          blurToPane(target);
          return;
        }
        if (hasError) {
          onDismissError();
          return;
        }
        return false;
      },
    },
  ];
  useKeymap(bindings);
}
