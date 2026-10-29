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
import { useKeymapState } from "../keyboard/context";
import type { WhatsNewRequest } from "../lib/releaseNotes";

export type ShellMode = "NORMAL" | "INSERT" | "COMMAND" | "CONFIRM" | "HELP";

/** Outcome of a toast notice; a notice without one is plain information. */
export type NoticeTone = "ok" | "warn" | "fail";

export interface NotifyOptions {
  tone?: NoticeTone;
  durationMs?: number;
}

export interface ShellStateValue {
  commandLineOpen: boolean;
  /** Text the command line opens with (":" opens empty, a caller may prefill "update "). */
  commandLineInitial: string;
  helpOpen: boolean;
  /** The release notes the "what's new" overlay shows, or null while it is closed. */
  whatsNew: WhatsNewRequest | null;
  /** Number of confirm/review surfaces currently open (CONFIRM mode while > 0). */
  confirmDepth: number;
  /** Transient one-line message, shown as the toast. */
  notice: string | null;
  noticeTone: NoticeTone | null;
  /** Changes with every notice, so an identical repeat still restarts its entrance. */
  noticeId: number;
  openCommandLine: (initialText?: string) => void;
  closeCommandLine: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  toggleHelp: () => void;
  /** Opens the "what's new" overlay; `request.onClose` runs once when it is closed. */
  openWhatsNew: (request: WhatsNewRequest) => void;
  closeWhatsNew: () => void;
  /** Marks a confirm/review surface as open; returns the release function. */
  beginConfirm: () => () => void;
  /** A bare number is the duration, kept for older callers; prefer `{ tone, durationMs }`. */
  notify: (text: string, options?: number | NotifyOptions) => void;
}

const NOTICE_MS = 4000;

const noop = () => {};

const DETACHED_STATE: ShellStateValue = {
  commandLineOpen: false,
  commandLineInitial: "",
  helpOpen: false,
  whatsNew: null,
  confirmDepth: 0,
  notice: null,
  noticeTone: null,
  noticeId: 0,
  openCommandLine: noop,
  closeCommandLine: noop,
  openHelp: noop,
  closeHelp: noop,
  toggleHelp: noop,
  openWhatsNew: noop,
  closeWhatsNew: noop,
  beginConfirm: () => noop,
  notify: noop,
};

const ShellStateContext = createContext<ShellStateValue>(DETACHED_STATE);

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [commandLineOpen, setCommandLineOpen] = useState(false);
  const [commandLineInitial, setCommandLineInitial] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [whatsNew, setWhatsNew] = useState<WhatsNewRequest | null>(null);
  const whatsNewRef = useRef<WhatsNewRequest | null>(null);
  const [confirmDepth, setConfirmDepth] = useState(0);
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone | null; id: number } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeSeq = useRef(0);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

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

  const openWhatsNew = useCallback((request: WhatsNewRequest) => {
    setCommandLineOpen(false);
    setHelpOpen(false);
    whatsNewRef.current = request;
    setWhatsNew(request);
  }, []);
  const closeWhatsNew = useCallback(() => {
    const request = whatsNewRef.current;
    if (!request) return;
    whatsNewRef.current = null;
    setWhatsNew(null);
    request.onClose?.();
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
      whatsNew,
      confirmDepth,
      notice: notice?.text ?? null,
      noticeTone: notice?.tone ?? null,
      noticeId: notice?.id ?? 0,
      openCommandLine,
      closeCommandLine,
      openHelp,
      closeHelp,
      toggleHelp,
      openWhatsNew,
      closeWhatsNew,
      beginConfirm,
      notify,
    }),
    [
      commandLineOpen,
      commandLineInitial,
      helpOpen,
      whatsNew,
      confirmDepth,
      notice,
      openCommandLine,
      closeCommandLine,
      openHelp,
      closeHelp,
      toggleHelp,
      openWhatsNew,
      closeWhatsNew,
      beginConfirm,
      notify,
    ],
  );

  return <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>;
}

export function useShellState(): ShellStateValue {
  return useContext(ShellStateContext);
}

/** Derived shell mode: COMMAND > HELP (also while "what's new" is open) > CONFIRM > INSERT > NORMAL. */
export function useShellMode(): ShellMode {
  const { commandLineOpen, helpOpen, whatsNew, confirmDepth } = useShellState();
  const { editing } = useKeymapState();
  if (commandLineOpen) return "COMMAND";
  if (helpOpen || whatsNew) return "HELP";
  if (confirmDepth > 0) return "CONFIRM";
  return editing ? "INSERT" : "NORMAL";
}

/** Views call this while a review/confirm surface is open so the shell mode is CONFIRM. */
export function useConfirmMode(active: boolean): void {
  const { beginConfirm } = useShellState();
  useEffect(() => {
    if (!active) return;
    return beginConfirm();
  }, [active, beginConfirm]);
}

export function useNotify(): ShellStateValue["notify"] {
  return useShellState().notify;
}
