import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useKeymapContext, useKeymapState } from "../keyboard/context";
import { echoOf, type EchoKey } from "../keyboard/echo";

export type ShellMode = "NORMAL" | "INSERT" | "COMMAND" | "CONFIRM" | "HELP";

/** Outcome colour of a status-bar notice; a notice without one is plain information. */
export type NoticeTone = "ok" | "warn" | "fail";

export interface NotifyOptions {
  tone?: NoticeTone;
  durationMs?: number;
}

/** The key just handled and its hint, shown next to the mode badge for a moment. */
export interface KeyEcho extends EchoKey {
  /** Changes on every echo, so the same key twice restarts the entrance. */
  id: number;
}

export interface ShellStateValue {
  commandLineOpen: boolean;
  /** Text the command line opens with (":" opens empty, a caller may prefill "update "). */
  commandLineInitial: string;
  helpOpen: boolean;
  /** Number of confirm/review surfaces currently open (CONFIRM mode while > 0). */
  confirmDepth: number;
  /** Extra status-bar context after the view label ("claude > plan"). */
  statusContext: string | null;
  /** Transient one-line message shown in the status bar. */
  notice: string | null;
  noticeTone: NoticeTone | null;
  /** Changes with every notice, so an identical repeat still restarts its entrance. */
  noticeId: number;
  /** The last handled key with its hint (`u update`) while it is fresh; see `echoOf` for what counts. */
  echo: KeyEcho | null;
  openCommandLine: (initialText?: string) => void;
  closeCommandLine: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  toggleHelp: () => void;
  /** Marks a confirm/review surface as open; returns the release function. */
  beginConfirm: () => () => void;
  setStatusContext: (text: string | null) => void;
  /** A bare number is the duration, kept for older callers; prefer `{ tone, durationMs }`. */
  notify: (text: string, options?: number | NotifyOptions) => void;
}

const NOTICE_MS = 4000;
const ECHO_MS = 900;

const noop = () => {};

const DETACHED_STATE: ShellStateValue = {
  commandLineOpen: false,
  commandLineInitial: "",
  helpOpen: false,
  confirmDepth: 0,
  statusContext: null,
  notice: null,
  noticeTone: null,
  noticeId: 0,
  echo: null,
  openCommandLine: noop,
  closeCommandLine: noop,
  openHelp: noop,
  closeHelp: noop,
  toggleHelp: noop,
  beginConfirm: () => noop,
  setStatusContext: noop,
  notify: noop,
};

const ShellStateContext = createContext<ShellStateValue>(DETACHED_STATE);

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [commandLineOpen, setCommandLineOpen] = useState(false);
  const [commandLineInitial, setCommandLineInitial] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDepth, setConfirmDepth] = useState(0);
  const [statusContext, setStatusContext] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone | null; id: number } | null>(null);
  const [echo, setEcho] = useState<KeyEcho | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeSeq = useRef(0);
  const echoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const echoSeq = useRef(0);
  const keymapContext = useKeymapContext();

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (echoTimer.current) clearTimeout(echoTimer.current);
  }, []);

  // A binding that ran (key or hint click) echoes next to the mode badge; the keymap decides nothing about it.
  useEffect(() => {
    if (!keymapContext) return;
    const { keymap, platform } = keymapContext;
    return keymap.onRun(run => {
      const next = echoOf(run, platform);
      if (!next) return;
      if (echoTimer.current) clearTimeout(echoTimer.current);
      setEcho({ ...next, id: ++echoSeq.current });
      echoTimer.current = setTimeout(() => {
        echoTimer.current = null;
        setEcho(null);
      }, ECHO_MS);
    });
  }, [keymapContext]);

  const openCommandLine = useCallback((initialText = "") => {
    setHelpOpen(false);
    setCommandLineInitial(initialText);
    setCommandLineOpen(true);
  }, []);
  const closeCommandLine = useCallback(() => setCommandLineOpen(false), []);
  const openHelp = useCallback(() => {
    setCommandLineOpen(false);
    setHelpOpen(true);
  }, []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const toggleHelp = useCallback(() => {
    setCommandLineOpen(false);
    setHelpOpen(open => !open);
  }, []);

  const beginConfirm = useCallback(() => {
    setConfirmDepth(depth => depth + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setConfirmDepth(depth => Math.max(0, depth - 1));
    };
  }, []);

  const notify = useCallback((text: string, options: number | NotifyOptions = {}) => {
    const { tone = null, durationMs = NOTICE_MS } = typeof options === "number" ? { durationMs: options } : options;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, tone, id: ++noticeSeq.current });
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, durationMs);
  }, []);

  const value = useMemo<ShellStateValue>(
    () => ({
      commandLineOpen,
      commandLineInitial,
      helpOpen,
      confirmDepth,
      statusContext,
      notice: notice?.text ?? null,
      noticeTone: notice?.tone ?? null,
      noticeId: notice?.id ?? 0,
      echo,
      openCommandLine,
      closeCommandLine,
      openHelp,
      closeHelp,
      toggleHelp,
      beginConfirm,
      setStatusContext,
      notify,
    }),
    [
      commandLineOpen,
      commandLineInitial,
      helpOpen,
      confirmDepth,
      statusContext,
      notice,
      echo,
      openCommandLine,
      closeCommandLine,
      openHelp,
      closeHelp,
      toggleHelp,
      beginConfirm,
      notify,
    ],
  );

  return <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>;
}

export function useShellState(): ShellStateValue {
  return useContext(ShellStateContext);
}

/** Derived mode shown in the status bar: COMMAND > HELP > CONFIRM > INSERT > NORMAL. */
export function useShellMode(): ShellMode {
  const { commandLineOpen, helpOpen, confirmDepth } = useShellState();
  const { editing } = useKeymapState();
  if (commandLineOpen) return "COMMAND";
  if (helpOpen) return "HELP";
  if (confirmDepth > 0) return "CONFIRM";
  return editing ? "INSERT" : "NORMAL";
}

/** Views call this while a review/confirm surface is open so the status bar shows CONFIRM. */
export function useConfirmMode(active: boolean): void {
  const { beginConfirm } = useShellState();
  useEffect(() => {
    if (!active) return;
    return beginConfirm();
  }, [active, beginConfirm]);
}

/** Views append a sub-context to the status bar ("claude > plan") while mounted. */
export function useStatusContext(text: string | null): void {
  const { setStatusContext } = useShellState();
  useEffect(() => {
    setStatusContext(text);
    return () => setStatusContext(null);
  }, [text, setStatusContext]);
}

export function useNotify(): ShellStateValue["notify"] {
  return useShellState().notify;
}
