import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentMotion } from "../lib/motion";

/** Length of the roll; the CSS animation and the removal of the leaving value share it. */
export const ROLL_MS = 200;

interface RollingTextProps {
  children: string;
  /** Applied to the visible value and kept on the leaving one, so a tone change does not recolour what slides out. */
  className?: string;
}

interface Leaving {
  text: string;
  className?: string;
}

/**
 * Text whose value changes in place: while motion is `full` the old value slides up and out and the new one
 * slides in (`.roll-*` in `_primitives.scss`: transform and opacity inside the text's own box, so nothing around
 * it moves). `subtle` and `off` swap instantly. It animates only when `children` changes after the first render;
 * give it a `key` where the subject itself changes (the row under the cursor) so a new subject is not a roll.
 * The leaving copy is aria-hidden, so the accessible text is always the current value.
 */
export function RollingText({ children, className }: RollingTextProps) {
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const previous = useRef<Leaving>({ text: children, className });

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { text: children, className };
    if (before.text === children) return;
    setLeaving(currentMotion() === "full" ? before : null);
  }, [children, className]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), ROLL_MS + 40);
    return () => clearTimeout(timer);
  }, [leaving]);

  return (
    <span className="roll" data-rolling={leaving ? "" : undefined}>
      {leaving && (
        <span key={`out:${leaving.text}`} className={`roll-old ${leaving.className ?? ""}`.trim()} aria-hidden="true">
          {leaving.text}
        </span>
      )}
      <span key={`in:${children}`} className={`roll-new ${className ?? ""}`.trim()}>
        {children}
      </span>
    </span>
  );
}
