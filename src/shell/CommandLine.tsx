import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCommandList, usePlatform } from "../keyboard/context";
import { parseCommandLine } from "../keyboard/commands/parser";
import { suggest, type Suggestion } from "../keyboard/commands/suggest";
import { useRestoreFocus } from "./overlay";
import { useShellState } from "./ShellState";

/**
 * `:` / Mod+k command line. A modal `role=dialog` holding a combobox input and a suggestion listbox.
 * Up/Down or Ctrl-n/Ctrl-p select, Tab completes the highlighted suggestion, Enter runs, Esc closes.
 *
 * Enter runs the typed line when it parses. If the user arrowed to a suggestion, Enter runs that one. If
 * the typed line is incomplete or ambiguous, Enter completes to the highlighted suggestion instead of
 * guessing, so a mutating command is never run on a target the user did not name.
 */
export function CommandLine() {
  const { commandLineOpen, commandLineInitial } = useShellState();
  return commandLineOpen ? <CommandLineBox initial={commandLineInitial} /> : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CommandLineBox({ initial }: { initial: string }) {
  const { closeCommandLine, notify } = useShellState();
  const commands = useCommandList();
  const platform = usePlatform();
  const [text, setText] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [explicit, setExplicit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  useRestoreFocus();

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  const suggestions = useMemo(() => suggest(text, commands), [text, commands]);
  const current = suggestions.length === 0 ? -1 : Math.min(selected, suggestions.length - 1);
  const optionId = (index: number) => `${listId}-opt-${index}`;

  const edit = (next: string) => {
    setText(next);
    setSelected(0);
    setExplicit(false);
    setError(null);
  };

  const complete = (suggestion: Suggestion) => {
    edit(`${suggestion.text} `);
    inputRef.current?.focus();
  };

  const move = (delta: number) => {
    if (suggestions.length === 0) return;
    setSelected((Math.max(0, current) + delta + suggestions.length) % suggestions.length);
    setExplicit(true);
  };

  /** Parses and runs `line`. Returns false (and shows why) when it cannot run. */
  const execute = (line: string): boolean => {
    const parsed = parseCommandLine(line, commands);
    if (!parsed.ok) {
      setError(parsed.error);
      return false;
    }
    const reason = parsed.cmd.enabled ? parsed.cmd.enabled() : true;
    if (reason !== true) {
      setError(`${parsed.cmd.name}: ${reason}`);
      return false;
    }
    closeCommandLine();
    try {
      void Promise.resolve(parsed.cmd.run(parsed)).catch((failure: unknown) =>
        notify(`${parsed.cmd.name}: ${errorMessage(failure)}`),
      );
    } catch (failure) {
      notify(`${parsed.cmd.name}: ${errorMessage(failure)}`);
    }
    return true;
  };

  const runSuggestion = (suggestion: Suggestion) => {
    if (suggestion.disabled) {
      setError(`${suggestion.command}: ${suggestion.disabled}`);
      return;
    }
    if (!execute(suggestion.text)) complete(suggestion);
  };

  const onEnter = () => {
    const chosen = current >= 0 ? suggestions[current] : undefined;
    if (explicit && chosen) {
      runSuggestion(chosen);
      return;
    }
    if (parseCommandLine(text, commands).ok) {
      execute(text);
      return;
    }
    // Completing would not change the line (it is already what the suggestion says): report why it cannot run.
    if (chosen && chosen.text !== text.trim()) {
      complete(chosen);
      return;
    }
    execute(text);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "ArrowDown" || (ctrl && event.key.toLowerCase() === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (ctrl && event.key.toLowerCase() === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const chosen = current >= 0 ? suggestions[current] : undefined;
      if (event.shiftKey) move(-1);
      else if (chosen) complete(chosen);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onEnter();
    }
  };

  const onOverlayKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape" || (mod && !event.altKey && event.key.toLowerCase() === "k")) {
      event.preventDefault();
      closeCommandLine();
    }
  };

  return (
    <div
      className="cmdline-overlay"
      data-keyscope="overlay"
      onKeyDown={onOverlayKeyDown}
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeCommandLine();
      }}
    >
      <div className="cmdbox" role="dialog" aria-modal="true" aria-label="Command line">
        <div className="line">
          <span className="colon" aria-hidden="true">:</span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Command"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listId : undefined}
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="command"
            value={text}
            onChange={event => edit(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <div className="sug">
          {suggestions.length > 0 && (
            <div id={listId} role="listbox" aria-label="Suggestions">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.text}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  aria-disabled={suggestion.disabled ? true : undefined}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => runSuggestion(suggestion)}
                >
                  <span className="g c-acc" aria-hidden="true">{index === current ? "▸" : " "}</span>{" "}
                  <span>{suggestion.text}</span>{" "}
                  <span className="d">{suggestion.disabled ?? suggestion.description}</span>
                </button>
              ))}
            </div>
          )}
          {suggestions.length === 0 && !error && <p className="d">no matching command</p>}
          {error && (
            <p className="d c-fail" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
