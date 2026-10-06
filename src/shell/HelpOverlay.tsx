import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCommandList, useKeymapEntries, usePlatform } from "../keyboard/context";
import { formatKeys, type Platform } from "../keyboard/keymap";
import { bindingGroup, evaluateWhen, type RegisteredBinding } from "../keyboard/registry";
import { ActionKey } from "../ui/ActionKey";
import { KeyCaps } from "../ui/Kbd";
import { trapTab, useRestoreFocus } from "./overlay";
import { useShellState } from "./ShellState";

const GROUP_ORDER = ["Navigate", "General", "Lists", "Pane", "Editor", "Overlay"];

interface HelpLine {
  key: string;
  tokens: string[];
  title: string;
  disabled: string | null;
}

interface HelpGroup {
  name: string;
  lines: HelpLine[];
}

function compareGroups(a: string, b: string): number {
  const ai = GROUP_ORDER.indexOf(a);
  const bi = GROUP_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? GROUP_ORDER.length : ai) - (bi === -1 ? GROUP_ORDER.length : bi);
  return a.localeCompare(b);
}

/** Groups registered bindings for display. Identical lines (the same list binding from several panes) collapse. */
export function groupBindings(entries: readonly RegisteredBinding[], platform: Platform): HelpGroup[] {
  const groups = new Map<string, Map<string, HelpLine>>();
  for (const { binding } of entries) {
    const name = bindingGroup(binding);
    const tokens = (typeof binding.keys === "string" ? [binding.keys] : [...binding.keys])
      .map(spec => formatKeys(spec, platform).join(" "))
      .join(" / ");
    const lineKey = `${tokens}\u0000${binding.title}`;
    const bucket = groups.get(name) ?? new Map<string, HelpLine>();
    groups.set(name, bucket);
    if (bucket.has(lineKey)) continue;
    const { disabledReason } = evaluateWhen(binding);
    bucket.set(lineKey, {
      key: lineKey,
      tokens: formatKeys(binding.keys, platform),
      title: binding.title,
      disabled: disabledReason,
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareGroups(a, b))
    .map(([name, bucket]) => ({ name, lines: [...bucket.values()] }));
}

/**
 * `?` overlay generated from the registries: every registered binding grouped by its `group`, then every
 * command. Nothing here is hand-written, so it cannot drift from what the keys actually do.
 */
export function HelpOverlay() {
  const { helpOpen } = useShellState();
  return helpOpen ? <HelpBody /> : null;
}

/** Rows a j/k or arrow press scrolls. */
const SCROLL_STEP_LINES = 3;

/** Scrolls the box for a key the overlay owns while focus sits on the dialog; false: not a scroll key. */
function scrollHelpBox(box: HTMLElement | null, event: Pick<ReactKeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  if (!box || event.ctrlKey || event.metaKey || event.altKey) return false;
  const line = parseFloat(getComputedStyle(box).lineHeight) || 20;
  const page = Math.max(line, box.clientHeight * 0.9);
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
    case "j":
      next = box.scrollTop + line * SCROLL_STEP_LINES;
      break;
    case "ArrowUp":
    case "k":
      next = box.scrollTop - line * SCROLL_STEP_LINES;
      break;
    case "PageDown":
      next = box.scrollTop + page;
      break;
    case "PageUp":
      next = box.scrollTop - page;
      break;
    case "g":
    case "Home":
      next = 0;
      break;
    case "G":
    case "End":
      next = max;
      break;
    default:
      return false;
  }
  box.scrollTop = Math.min(max, Math.max(0, next));
  return true;
}

function HelpBody() {
  const { closeHelp } = useShellState();
  const entries = useKeymapEntries();
  const commands = useCommandList();
  const platform = usePlatform();
  const dialogRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useRestoreFocus();

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const groups = useMemo(() => groupBindings(entries, platform), [entries, platform]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "?" || event.key === "q") {
      event.preventDefault();
      closeHelp();
      return;
    }
    // Focus stays on the dialog while .help-box is what scrolls, so the browser would not scroll it by itself.
    if (scrollHelpBox(boxRef.current, event)) {
      event.preventDefault();
      return;
    }
    trapTab(event, dialogRef.current);
  };

  return (
    <div
      ref={dialogRef}
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard help"
      tabIndex={-1}
      data-keyscope="overlay"
      onKeyDown={onKeyDown}
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeHelp();
      }}
    >
      <div ref={boxRef} className="help-box">
        <h2>keyboard</h2>
        <div className="help-cols">
          {groups.map(group => (
            <section key={group.name} aria-label={group.name}>
              <h3 className="group">{group.name}</h3>
              <dl className="kv">
                {group.lines.map(line => (
                  <HelpRow key={line.key} line={line} />
                ))}
              </dl>
            </section>
          ))}
          {commands.length > 0 && (
            <section aria-label="Commands">
              <h3 className="group">Commands (:)</h3>
              <dl className="kv">
                {commands.map(command => (
                  <HelpCommandRow key={command.name} name={command.name} aliases={command.aliases ?? []} summary={command.summary} />
                ))}
              </dl>
            </section>
          )}
        </div>
        <p className="foot">
          <ActionKey keys={["esc"]} onClick={closeHelp}>
            close
          </ActionKey>
        </p>
      </div>
    </div>
  );
}

function HelpRow({ line }: { line: HelpLine }) {
  return (
    <>
      <dt>
        <KeyCaps keys={line.tokens} />
      </dt>
      <dd className={line.disabled ? "c-dim" : undefined}>
        {line.title}
        {line.disabled ? ` (${line.disabled})` : ""}
      </dd>
    </>
  );
}

function HelpCommandRow({ name, aliases, summary }: { name: string; aliases: readonly string[]; summary: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>
        {summary}
        {aliases.length > 0 && <span className="c-dim"> · {aliases.join(", ")}</span>}
      </dd>
    </>
  );
}
