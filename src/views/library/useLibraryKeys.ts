import { useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useCommands } from "../../keyboard/commands/useCommands";
import type { CommandSpec } from "../../keyboard/commands/parser";
import type { Binding } from "../../keyboard/registry";
import { useKeymap } from "../../keyboard/useKeymap";
import type { LibraryEntry } from "./entry";

interface LibraryKeysOptions {
  /** The Library's root: its bindings are live while focus is inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** The open sheet's element, or a ref that is empty while no sheet is open. */
  sheetRef: RefObject<HTMLElement | null>;
  sheetOpen: boolean;
  /** The item in the sheet, once loaded. */
  entry: LibraryEntry | null;
  /** Focuses the search field and selects its text. */
  focusSearch: () => void;
  /** Moves to the previous (-1) or next (+1) topic. */
  stepTopic: (delta: number) => void;
  /** Opens "New doc"; null while the Library cannot create one (no workspace folder). */
  newDoc: (() => void) | null;
  /** Closes the sheet, asking first when there are unsaved changes. */
  requestClose: () => void | Promise<void>;
  /** The skills `:disable` and `:enable` may name and how to set them; null while skills cannot be toggled. */
  skillToggle?: SkillToggle | null;
}

export interface SkillToggle {
  disableable: readonly string[];
  enableable: readonly string[];
  set: (names: string[], enabled: boolean) => unknown;
}

/** The names of a `:disable a b` line. */
function namesOf(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/\s+/).filter(Boolean))];
}

/** Rows the arrow keys move between: the first verb of each row. */
const ROW_STOP = "[data-row-primary]";

/**
 * Library key layer, mouse-first with keys that speed it up. While no sheet is open: `/` searches, `[` and `]` step
 * through the topics, the arrow keys move between rows (Enter or Space on a row's button opens it, as any button),
 * Mod+N makes a new doc and Mod+F searches too (those two are handled on the root element, not registered: the window
 * key layer leaves them to the webview by design). In the sheet: Mod+S saves, Escape closes (asks first when edits are
 * unsaved). The command line gets `:w`, `:q` and `:reset` for the open item. Guards live with the controller.
 */
export function useLibraryKeys({
  rootRef,
  sheetRef,
  sheetOpen,
  entry,
  focusSearch,
  stepTopic,
  newDoc,
  requestClose,
  skillToggle = null,
}: LibraryKeysOptions): { onRootKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } {
  const latest = useRef(entry);
  latest.current = entry;
  const toggle = useRef(skillToggle);
  toggle.current = skillToggle;

  const moveRow = (delta: number): void | false => {
    const root = rootRef.current;
    if (!root) return false;
    const stops = Array.from(root.querySelectorAll<HTMLElement>(ROW_STOP));
    const active = document.activeElement;
    const current = active instanceof Element ? active.closest(".lib-row")?.querySelector<HTMLElement>(ROW_STOP) ?? null : null;
    if (current === null) {
      // From a tab or the search field: down enters the rows, up has nowhere to go.
      if (delta > 0 && stops[0]) stops[0].focus();
      else return false;
      return;
    }
    const next = stops[stops.indexOf(current) + delta];
    if (next) next.focus();
    else if (delta < 0) root.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
  };

  const rootBindings: Binding[] = [
    {
      id: "library.search",
      keys: "/",
      title: "Search the Library",
      hint: "search",
      group: "Library",
      scope: "pane",
      when: () => !sheetOpen,
      run: focusSearch,
    },
    {
      id: "library.topic.prev",
      keys: ["[", "<"],
      title: "Previous topic",
      group: "Library",
      scope: "pane",
      when: () => !sheetOpen,
      run: () => stepTopic(-1),
    },
    {
      id: "library.topic.next",
      keys: ["]", ">"],
      title: "Next topic",
      group: "Library",
      scope: "pane",
      when: () => !sheetOpen,
      run: () => stepTopic(1),
    },
    {
      id: "library.row.next",
      keys: "ArrowDown",
      title: "Next row",
      group: "Library",
      scope: "pane",
      repeat: true,
      when: () => !sheetOpen,
      run: () => moveRow(1),
    },
    {
      id: "library.row.prev",
      keys: "ArrowUp",
      title: "Previous row",
      group: "Library",
      scope: "pane",
      repeat: true,
      when: () => !sheetOpen,
      run: () => moveRow(-1),
    },
  ];
  useKeymap(rootBindings, { ref: rootRef });

  const save = () => {
    const current = latest.current;
    if (!current || current.readOnly || !current.dirty || current.saving) return;
    void current.onSave();
  };

  const sheetBindings: Binding[] = [
    {
      id: "library.save",
      keys: "Mod+s",
      title: "Save the open item",
      group: "Library",
      scope: "overlay",
      inEditable: true,
      when: () => (latest.current && !latest.current.readOnly ? true : false),
      run: save,
    },
    {
      id: "library.close",
      keys: "Escape",
      title: "Close the open item",
      group: "Library",
      scope: "overlay",
      inEditable: true,
      run: () => {
        void requestClose();
      },
    },
  ];
  useKeymap(sheetBindings, { ref: sheetRef, enabled: sheetOpen });

  const hasItem = () => (latest.current ? true : "nothing is open");
  const commands: CommandSpec[] = [
    {
      name: "w",
      aliases: ["write"],
      summary: "save the open item",
      group: "Library",
      enabled: () => (latest.current?.readOnly ? latest.current.readOnlyReason ?? "read-only item" : hasItem()),
      run: save,
    },
    {
      name: "q",
      aliases: ["close"],
      summary: "close the open item (asks before discarding edits)",
      group: "Library",
      enabled: () => (sheetOpen ? true : "nothing is open"),
      run: () => void requestClose(),
    },
    {
      name: "reset",
      summary: "discard unsaved edits of the open item",
      group: "Library",
      enabled: () => (latest.current?.dirty ? true : "no unsaved changes"),
      run: () => latest.current?.onReset(),
    },
    ...([false, true] as const).map((enabled): CommandSpec => {
      const verb = enabled ? "enable" : "disable";
      const allowed = () => (enabled ? toggle.current?.enableable : toggle.current?.disableable) ?? [];
      return {
        name: verb,
        summary: enabled
          ? "enable disabled skills again (the next Update installs them)"
          : "disable skills for every harness (asks first; the next Update removes them)",
        group: "Library",
        args: [{ name: "names", kind: "rest", description: "skill names" }],
        complete: ({ args }) => allowed().filter(name => !args.includes(name)).map(value => ({ value })),
        enabled: () => (toggle.current ? true : "skills cannot be enabled or disabled now"),
        validate: parsed => {
          const names = namesOf(parsed.named.names);
          if (names.length === 0) return `${verb}: name a skill`;
          const refused = names.find(name => !allowed().includes(name));
          if (refused === undefined) return null;
          return enabled ? `${verb}: ${refused} is not disabled` : `${verb}: ${refused} is not a bundled or active pack skill that is enabled`;
        },
        run: parsed => {
          void toggle.current?.set(namesOf(parsed.named.names), enabled);
        },
      };
    }),
  ];
  useCommands(commands);

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    // Not while a dialog is up: Mod+N typed in "New doc" must not start another one, and the sheet has its own keys.
    if (sheetOpen || event.nativeEvent.isComposing || document.querySelector("dialog[open]")) return;
    if (key === "f") {
      event.preventDefault();
      focusSearch();
    } else if (key === "n" && newDoc) {
      event.preventDefault();
      newDoc();
    }
  };

  return { onRootKeyDown };
}
