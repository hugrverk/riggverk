import { useEffect, useRef, useState } from "react";
import { isModifierKey } from "../keyboard/keymap";
import { currentMotion } from "../lib/motion";
import { cx } from "../ui/tone";

/** What the boot lines can say. Every field is optional; a line whose data is missing is skipped. */
export interface BootInfo {
  version?: string;
  /** The workspace folder; null: none is installed, undefined: not loaded yet (the line is skipped). */
  workspace?: string | null;
  /** Git branch of the workspace, when it is a repository. */
  branch?: string | null;
  dirty?: boolean;
  harnesses?: readonly string[];
  backups?: number;
}

interface BootLine {
  label: string;
  value: string;
}

const STEPS = ["version", "workspace", "branch", "harnesses", "backups", "ready"] as const;
type BootStep = (typeof STEPS)[number];

function bootLine(step: BootStep, info: BootInfo): BootLine | null {
  switch (step) {
    case "version":
      return { label: "❯ ", value: info.version ? `agent-workspace ${info.version}` : "agent-workspace" };
    case "workspace":
      return info.workspace === undefined ? null : { label: "  workspace  ", value: info.workspace ?? "no workspace" };
    case "branch":
      return info.branch ? { label: "  branch     ", value: `${info.branch} · ${info.dirty ? "dirty" : "clean"}` } : null;
    case "harnesses":
      return info.harnesses && info.harnesses.length > 0
        ? { label: "  harnesses  ", value: info.harnesses.join(" · ") }
        : null;
    case "backups":
      return info.backups === undefined
        ? null
        : { label: "  backups    ", value: `${info.backups} run${info.backups === 1 ? "" : "s"}` };
    case "ready":
      return { label: "❯ ", value: "ready" };
  }
}

const TICK_MS = 14;
/** A line types in at most this many ticks, however long it is. */
const MAX_TICKS_PER_LINE = 9;
const LINE_GAP_MS = 45;
const HOLD_MS = 280;
const FADE_MS = 200;

/** Once per process; a module reload (HMR) keeps it through `import.meta.hot`. */
let launched = import.meta.hot?.data?.bootLaunched === true;
import.meta.hot?.dispose(data => {
  data.bootLaunched = launched;
});

/** Forgets that the launch sequence already ran. For tests. */
export function resetBootLaunch(): void {
  launched = false;
}

type BootMode = "typed" | "veil";

/** The launch sequence for the current motion level: typed lines at full, a short fade-in at subtle, nothing at off. */
function launchMode(autoplay: boolean): BootMode | null {
  if (!autoplay || launched) return null;
  const level = currentMotion();
  return level === "full" ? "typed" : level === "subtle" ? "veil" : null;
}

export interface BootProps {
  info: BootInfo;
  /** Bumped to replay the typed sequence (`:boot`). Ignored unless motion is full. */
  run?: number;
  /** Play the launch sequence on mount. Off under vitest so existing tests stay untouched; boot tests turn it on. */
  autoplay?: boolean;
  /** Called when the overlay is gone, however it ended. */
  onDone?: () => void;
}

/**
 * Launch overlay, mounted by AppFrame once the settings are known so the motion level is final. Full motion types a
 * few lines about the workspace and fades out in about a second and a half; any key or click ends it at once and is
 * not passed on. Subtle fades the shell in instead; off shows nothing. It plays once per process, and again on `run`.
 */
export function Boot({ info, run = 0, autoplay = import.meta.env.MODE !== "test", onDone }: BootProps) {
  const [mode, setMode] = useState<BootMode | null>(() => launchMode(autoplay));
  const lastRun = useRef(run);

  useEffect(() => {
    if (run === lastRun.current) return;
    lastRun.current = run;
    if (currentMotion() === "full") setMode("typed");
  }, [run]);

  if (!mode) return null;
  return (
    <BootScreen
      key={run}
      mode={mode}
      info={info}
      onDone={() => {
        launched = true;
        setMode(null);
        onDone?.();
      }}
    />
  );
}

interface Row extends BootLine {
  typing: boolean;
}

function BootScreen({ mode, info, onDone }: { mode: BootMode; info: BootInfo; onDone: () => void }) {
  // The lines read the newest info when they start, so data that loads while the sequence runs still gets in.
  const infoRef = useRef(info);
  infoRef.current = info;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [rows, setRows] = useState<Row[]>([]);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;

    const unlisten = () => {
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener("mousedown", skip, true);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      unlisten();
      setLeaving(true);
      timer = setTimeout(() => doneRef.current(), FADE_MS + 20);
    };
    // Capture phase on window: the key never reaches the keymap, so it is not run as a command.
    function skip(event: Event) {
      if (event instanceof KeyboardEvent && isModifierKey(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      end();
    }

    if (mode === "veil") {
      end();
      return () => {
        clearTimeout(timer);
      };
    }

    window.addEventListener("keydown", skip, true);
    window.addEventListener("mousedown", skip, true);

    let step = 0;
    let rowIndex = 0;
    const next = () => {
      while (step < STEPS.length) {
        const line = bootLine(STEPS[step++]!, infoRef.current);
        if (line) {
          typeLine(line, rowIndex++);
          return;
        }
      }
      timer = setTimeout(end, HOLD_MS);
    };
    const typeLine = (line: BootLine, index: number) => {
      const stride = Math.max(1, Math.ceil(line.value.length / MAX_TICKS_PER_LINE));
      let shown = 0;
      const tick = () => {
        shown = Math.min(line.value.length, shown + stride);
        const row: Row = { ...line, value: line.value.slice(0, shown), typing: shown < line.value.length };
        setRows(current => {
          const copy = [...current];
          copy[index] = row;
          return copy;
        });
        timer = row.typing ? setTimeout(tick, TICK_MS) : setTimeout(next, LINE_GAP_MS);
      };
      tick();
    };
    next();

    return () => {
      ended = true;
      clearTimeout(timer);
      unlisten();
    };
  }, [mode]);

  return (
    <div className={cx("boot", mode === "veil" && "veil", leaving && "out")} aria-hidden="true">
      {rows.map((row, index) => (
        <span key={index} className="ln">
          <span className="k">{row.label}</span>
          {row.value}
          {row.typing && <span className="tui-caret" />}
        </span>
      ))}
    </div>
  );
}
